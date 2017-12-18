#!/usr/bin/env node

const argv = require('yargs')
  .option('couch', {
    describe: 'CouchDB database to replicate package information from',
    default: process.env.COUCH_URL,
    demand: true
  })
  .option('es', {
    describe: 'ElasticSearch to populate with search data',
    default: process.env.ELASTIC_SEARCH ? `http://${process.env.ELASTIC_SEARCH}`: undefined,
    demand: true
  })
  .option('queueDepth', {
    describe: 'Max number of docs in the backlog',
    default: process.env.QUEUE_DEPTH || 2048,
  })
  .option('since', {
    describe: 'Sequence # in couch to begin indexing from',
    default: 0
  })
  .option('monitorPort', {
    describe: 'The port on which to run the monitoring service',
    default: process.env.MONITOR_PORT || 5000
  })
  .option('metrics', {
    describe: 'URL of the metrics sink',
    default: process.env.METRICS
  })
  .option('metricsReportFrequency', {
    describe: 'Frequency at which to report metrics',
    default: process.env.METRICS_REPORT_FREQUENCY || 10000
  })
  .option('leaderSequencePollFrequency', {
    describe: `frequency at which to poll leader's max sequence`,
    default: process.env.LEADER_SEQUENCE_POLL_FREQUENCY || 10000
  })
  .help()
  .argv;

const follow = require('follow'),
    normalize = require('npm-normalize'),
    request = require('request'),
    Emitter = require('numbat-emitter'),
    procMetrics = require('numbat-process'),
    Monitor = require('micro-monitor'),
    extend = require('extend'),
    interval = argv.interval || 1000,
    seqUrl = argv.es + '/config/sequence',
    since = argv.since,
    Queue = require('async').queue;

// Configure only if a sink is supplied
if (argv.metrics) {
  const metrics = new Emitter({
    app: 'npm2es2',
    uri: argv.metrics
  })
  Emitter.setGlobalEmitter(metrics)
  procMetrics(metrics, argv.metricsReportFrequency)
}

if (typeof since === 'undefined') {
  request.get({
    url : seqUrl,
    json: true
  }, function(e, r, o) {
    if (!r) {
      return console.error('ERROR:', 'could not connect to elasticsearch (' + argv.es + ')');
    }

    if (!e && o && o._source && o._source.value) {
      since = o._source.value;
    } else {
      since = 0;
    }
    beginFollowing();
  });

} else {
  request.put({
    url : seqUrl,
    json : {
      value: since
    }
  }, function(e, r, o) {

    if (e) {
      throw e;
    }
    beginFollowing();
  });
}

function trackSequence({couch, metricsReportFrequency, leaderSequencePollFrequency}) {
  let followerSequence = 0
  let leaderSequence = 0
  const sequenceOffset = () => leaderSequence - followerSequence

  // Setup the monitor
  Monitor(argv.monitorPort).contribute(() => ({
    sequence: followerSequence,
    leaderSequence,
    sequenceOffset: sequenceOffset()
  }))

  // Report metrics
  setInterval(() => {
    process.emit('metric', {
      name: 'sequence.leader',
      value: leaderSequence
    })
    process.emit('metric', {
      name: 'sequence.follower',
      value: followerSequence
    })
    process.emit('metric', {
      name: 'sequence.offset',
      value: sequenceOffset()
    })
  }, metricsReportFrequency)

  // Poll leader sequence
  setInterval(() => {
    request.get(couch, (err, {statusCode}, body) => {
      if (err) {
        console.error('Failed to fetch last sequence from leader:', err)
      } else if (statusCode === 200) {
        leaderSequence = Number.parseInt(JSON.parse(body).update_seq)
      }
    })
  }, leaderSequencePollFrequency)

  // Supply the sequence updater function
  return (sequence) => {
    followerSequence = sequence || followerSequence
    leaderSequence = Math.max(leaderSequence, followerSequence)
  }
}

function beginFollowing() {
  var settings = {
    analysis: {
      filter: {
        worddelimiter: {
          type: "word_delimiter",
          preserve_original: true
        }
      },
      analyzer: {
        "letter_analyzer": {
          tokenizer: "letter",
          filter: ["worddelimiter"]
        }
      }
    }
  };

  request.put({
    url: argv.es,
    json: settings
  }, function(e) {
    if (e) return console.error('ERROR: could not put settings into elasticsearch ', e);

    request.get({
      url: argv.es + '/package/_mapping',
      json: true
    }, function(e, r, o) {

      var nameObj = {
        type: "multi_field",
        fields : {
          name : { type : "string", index : "analyzed" },
          untouched : { type : "string", index : "not_analyzed" }
        }
      };

      if (!e && !o.error && o.properties) {
        o['package'].properies.name = nameObj
      } else {
        o = {
          "package" : {
            "_all" : {
              "index_analyzer": "letter_analyzer"
            },
            properties : {
              name: nameObj
            }
          }
        };
      }

      request.put({
        url : argv.es + '/package/_mapping',
        json : o
      }, function() {})

    });

    console.log('BEGIN FOLLOWING @', since);

    var last = since,
      queue = _createThrottlingQueue(last, 16);

    const updateSequence = trackSequence(argv)

    follow({
      db: argv.couch,
      since: since,
      include_docs: true
    },  function(err, change) {
      var _this = this;

      if (err) {
        return console.error('ERROR:', err.message, argv.couch);
      }

      if (!change) {
        return;
      }

      if (!change.id) {
        return console.log('SKIP', change);
      }

      // only allow N items into
      // the queue at the same time.
      // otherwise a backlog can be
      // created which fills memory.
      if (queue.length() < argv.queueDepth) {
        updateSequence(change.seq)
        queue.push(change);
      } else {
        this.pause();
        queue.drain = function() {
          _this.resume();
        }
      }

    });
  });
}

// Create a queue that only allows concurrency
// indexing operations to occur in parallel.
function _createThrottlingQueue(last, concurrency) {
  var queue = Queue(function(change, callback) {

    if (last + interval < change.seq) {
      last = change.seq;
      request.put({
        url : seqUrl,
        json : {
          value: last
        }
      }, function(e, r, o) {
        if (e) {
          console.error('ERROR', 'could not save latest sequence', e.message);
          return callback();
        }

        console.log('SYNC', last);
      });
    }

    // Remove the document from elasticsearch
    if (change.deleted) {
      request.del(argv.es + '/package/package/' + encodeURIComponent(change.id), function(err) {
        if (!err) {
          console.log('DELETED', change.id);
        } else {
          console.error('ERROR', 'could not delete document', err);
        }
        callback();
      });

    // Add the document to elasticsearch
    } else {

      var p = normalize(change.doc);

      if (!p || !p.name) {
        console.log('SKIP: ' + change.doc._id);
        return callback();
      }

      p.stars = p && p.users ? p.users.length : 0;

      request({
        uri: 'https://api.npmjs.org/downloads/point/last-day/' + p.name,
        json: true,
        method: 'GET'
      }, function (e, r, bd) {

        if (e || bd.error) {
          console.error(e ? e.message : bd.error, p);
        } else {
          p.dlDay = bd.downloads;
        }

        // get download counts for the last week
        request({
          uri: 'https://api.npmjs.org/downloads/point/last-week/' + p.name,
          json: true,
          method: 'GET'
        }, function (e, r, bw) {
          if (e || bw.error) {
            console.error(e ? e.message : bw.error, p);
          } else {
            p.dlWeek = bw.downloads;
          }

          // get download counts for the last month
          request({
            uri: 'https://api.npmjs.org/downloads/point/last-month/' + p.name,
            json: true,
            method: 'GET'
          }, function (e, r, bm) {
            if (e || bm.error) {
              console.error(e ? e.message : bm.error, p);
            } else {
              p.dlMonth = bm.downloads;
            }

            // use that information to get a sense of trending popularity
            p.dlScore = p.dlWeek / (p.dlMonth / 4);

            request.get({
              url: argv.es + '/package/package/' + encodeURIComponent(p.name),
              json: true
            }, function(e,b, obj) {

              // follow gives us an update of the same document 2 times
              // 1) for the actual package.json update
              // 2) for the tarball
              // skip a re-index for #2
              if (!e && obj && obj._source && obj._source.version === p.version) {
                console.log('SKIP VERSION:', change.doc._id, p.version, 'queue backlog = ', queue.length());
                callback();
              } else {
                obj = obj || {};
                //get numberof dev
                if (p.dependencies){
                  p.numberOfDependencies = p.dependencies.length;
                }
                if (p.devDependencies){
                  p.numberOfDevDependencies = p.devDependencies.length;
                }
                // modern versions of ES don't allow
                // for keys with '.' in them.
                if (p.time) {
                  delete p.time
                }
                if (p.times) {
                  delete p.times
                }

                request.put({
                  url: argv.es + '/package/package/' + encodeURIComponent(p.name),
                  json: extend(obj._source || {}, p)
                }, function(e, r, b) {
                  if (e) {
                    console.error(e.message, p);
                  } else if (b.error) {
                    console.error(b.error, p);
                  } else {
                    console.log('ADD', p.name, 'status = ', r.statusCode, 'queue backlog = ', queue.length());
                  }
                  callback();
                });
              }
            });
          });
        });

      });
    }

  }, concurrency);

  return queue;
}
