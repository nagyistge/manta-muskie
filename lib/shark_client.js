/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;
var http = require('http');
var util = require('util');

var assert = require('assert-plus');
var backoff = require('backoff');
var KeepAliveAgent = require('keep-alive-agent');
var once = require('once');

var common = require('./common');



///--- Globals

var CLIENT_MAP = {};
var MAX_SOCKETS = 8192;



///--- Errors

function ConnectTimeoutError(host, time) {
    Error.captureStackTrace(this, ConnectTimeoutError);
    this.name = 'ConnectTimeoutError';
    this.message = util.format('failed to connect to %s in %dms', host, time);
}
util.inherits(ConnectTimeoutError, Error);


function SharkResponseError(res, body) {
    Error.captureStackTrace(this, SharkResponseError);
    this.name = 'SharkResponseError';
    this.message = util.format('mako failure:\nHTTP %d\n%s%s',
                               res.statusCode,
                               JSON.stringify(res.headers, null, 2),
                               body ? '\n' + body : '');
    this._result = res;
}
util.inherits(SharkResponseError, Error);



///--- Helpers

function _request(opts, cb) {
    cb = once(cb);

    var req = http.request(opts);
    var timer = setTimeout(function onTimeout() {
        if (req)
            req.abort();

        cb(new ConnectTimeoutError(opts.hostname, opts.connectTimeout));
    }, opts.connectTimeout);

    req.once('error', function onRequestError(err) {
        clearTimeout(timer);
        cb(err);
    });

    req.once('socket', function () {
        clearTimeout(timer);
    });

    function onResponse(res) {
        if (res.statusCode >= 400) {
            var body = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                body += chunk;
            });
            res.once('end', function () {
                cb(new SharkResponseError(res, body), req, res);
            });
            res.once('error', function (err) {
                cb(new SharkResponseError(res, err.toString()), req, res);
            });
            res.resume();
        } else {
            cb(null, req, res);
        }
    }

    req.once('continue', function () {
        req.removeListener('response', onResponse);
        cb(null, req);
    });

    req.once('response', onResponse);
    if (opts.method !== 'PUT')
        req.end();
}


function request(thisp, method, opts, cb) {
    cb = once(cb);

    var log = thisp.log;
    var _opts = {
        connectTimeout: thisp.connectTimeout,
        headers: opts.headers || {
            connection: 'keep-alive',
            'x-request-id': opts.requestId,
            range: opts.range
        },
        hostname: thisp.hostname,
        method: method,
        path: '/' + (opts.creator || opts.owner) + '/' + opts.objectId,
        port: thisp.port,
        requestId: opts.requestId
    };

    log.debug(_opts, 'request: entered');

    // don't log this
    _opts.agent = thisp.agent;

    var retry = backoff.call(_request, _opts, function (err, req, res) {
        if (err) {
            cb(err);
        } else {
            log.debug({
                requestId: opts.requestId
            }, 'request: done');
            cb(null, req, res);
        }
    });
    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: 100,
        maxDelay: 10000
    }));
    retry.failAfter(2);
    retry.start();
}


function sharkToUrl(shark) {
    assert.object(shark, 'shark');
    assert.string(shark.manta_storage_id);

    return ('http://' + shark.manta_storage_id);
}



///--- API

function SharkClient(options) {
    assert.object(options, 'options');
    assert.optionalNumber(options.connectTimeout, 'options.connectTimeout');
    assert.object(options.log, 'options.log');
    assert.optionalObject(options.retry, 'options.retry');
    assert.object(options.shark, 'options.shark');
    assert.optionalObject(options.agent, 'options.agent');

    EventEmitter.call(this);

    var self = this;

    this.agent = options.agent;
    if (this.agent === undefined) {
        this.agent = new KeepAliveAgent({
            maxSockets: MAX_SOCKETS
        });
    }
    this.connectTimeout = options.connectTimeout || 2000;
    this.hostname = options.shark.manta_storage_id;
    this.log = options.log.child({
        component: 'SharkClient',
        mako_hostname: self.hostname
    }, true);
    this.port = 80;

    this.close = once(function close() {
        if (self.agent.pools) {
            Object.keys(self.agent.pools).forEach(function (h) {
                self.agent.pools[h].stop();
            });
            self.agent.pools = {};
            return;
        }
        var sockets = self.agent.idleSockets || {};
        Object.keys(sockets).forEach(function (k) {
            sockets[k].forEach(function (s) {
                s.end();
            });
        });

        sockets = self.agent.sockets || {};
        Object.keys(sockets).forEach(function (k) {
            sockets[k].forEach(function (s) {
                s.end();
            });
        });
    });
}
util.inherits(SharkClient, EventEmitter);



/**
 * Wraps up the restify http_client.get request.
 *
 * Options needs:
 *   - objectId
 *   - owner
 *   - requestId
 *   - range (optional)
 *
 * @param {object} options see above
 * @param {function} callback => f(err, req)
 */
SharkClient.prototype.get = function get(opts, cb) {
    assert.object(opts, 'options');
    assert.string(opts.objectId, 'options.objectId');
    assert.string(opts.owner, 'options.owner');
    assert.string(opts.requestId, 'options.requestId');
    assert.optionalString(opts.range, 'options.range');
    assert.func(cb, 'callback');

    request(this, 'GET', opts, cb);
};


/**
 * Wraps up the restify http_client.head request.
 *
 * Options needs:
 *   - objectId
 *   - owner
 *   - requestId
 *   - range (optional)
 *
 * @param {object} options see above
 * @param {function} callback => f(err, req)
 */
SharkClient.prototype.head = function head(opts, cb) {
    assert.object(opts, 'options');
    assert.string(opts.objectId, 'options.objectId');
    assert.string(opts.owner, 'options.owner');
    assert.string(opts.requestId, 'options.requestId');
    assert.optionalString(opts.range, 'options.range');
    assert.func(cb, 'callback');

    request(this, 'HEAD', opts, cb);
};


/**
 * Wraps up the restify http_client.put request.
 *
 * Options needs:
 *   - contentLength
 *   - contentType
 *   - objectId
 *   - owner
 *   - requestId
 *
 * @param {object} options see above
 * @param {function} callback => f(err, req)
 */
SharkClient.prototype.put = function put(opts, cb) {
    assert.object(opts, 'options');
    assert.optionalNumber(opts.contentLength, 'options.contentLength');
    assert.string(opts.contentType, 'options.contentType');
    assert.string(opts.objectId, 'options.objectId');
    assert.string(opts.owner, 'options.owner');
    assert.string(opts.requestId, 'options.requestId');
    assert.optionalString(opts.contentMd5, 'options.contentMd5');
    assert.func(cb, 'callback');

    var _opts = {
        headers: {
            connection: 'keep-alive',
            'content-type': opts.contentType,
            expect: '100-continue',
            'x-request-id': opts.requestId
        },
        owner: opts.owner,
        objectId: opts.objectId
    };

    if (opts.contentLength !== undefined) {
        _opts.headers['content-length'] = opts.contentLength;
    } else {
        _opts.headers['transfer-encoding'] = 'chunked';
    }

    if (opts.contentMd5 !== undefined)
        _opts.headers['content-md5'] = opts.contentMd5;

    request(this, 'PUT', _opts, cb);
};


SharkClient.prototype.toString = function toString() {
    return ('[object SharkClient<' + this.hostname + '>]');
};



///--- Exports

module.exports = {

    /**
     * Maintains a cache of clients so we're not blowing through ephemeral
     * TCP ports.
     *
     * @params {object} option (see SharkClient)
     * @return {SharkClient} either from cache or created.
     */
    getClient: function getSharkClient(options) {
        assert.object(options, 'options');
        assert.object(options.shark, 'options.shark');

        var client;
        var id = options.shark.manta_storage_id;

        if (!(client = CLIENT_MAP[id])) {
            client = new SharkClient(options);
            CLIENT_MAP[id] = client;
        }

        return (client);
    }
};
