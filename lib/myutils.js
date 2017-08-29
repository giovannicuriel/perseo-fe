/*
 * Copyright 2015 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of perseo-fe
 *
 * perseo-fe is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * perseo-fe is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with perseo-fe.
 * If not, see http://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::[contacto@tid.es]
 */

'use strict';

var request = require('request'),
    util = require('util'),
    logger = require('logops'),
    constants = require('./constants'),
    metrics = require('./models/metrics');

function logErrorIf(err, message, context) {
    var level = 'error';
    if (context === undefined) {
        context = process.domain && process.domain.context;
    }
    if (err) {
        message = message || '';
        if (context) {
            context.op = context.op || new Error().stack.split('\n')[2].trim().substr(3);
            context.comp = context.comp || constants.COMPONENT_NAME;
            logger[level](context, message, err.message || JSON.stringify(err));
        }
        else {
            logger[level](message, err.message || JSON.stringify(err));
        }
    }

}



function tokenize(text, token) {
  let ret = [];
  let remainder = text;

  let beginIndex = remainder.indexOf(token);
  while (beginIndex >= 0) {
    let begin = remainder.slice(0, beginIndex);
    remainder = remainder.slice(beginIndex + token.length);
    ret.push(begin);
    beginIndex = remainder.indexOf(token);
  }
  ret.push(remainder);
  return ret;
}

function objectify(obj, path, value) {
  if (path.length === 1) {
    if (typeof obj === 'object') {
      obj[path[0]] = value;
    }
  } else {
    let currAttr = path[0];
    path.shift();
    if (obj[currAttr] === undefined) {
      obj[currAttr] = {};
    }
    obj[currAttr] = objectify(obj[currAttr], path, value);
  }
  return obj;
}


function unflattenMap(targetMap) {
  var newMap = {};
  for (let k in targetMap) {
    if (targetMap.hasOwnProperty(k)) {
      let path = tokenize(k, '__');
      if (path.length === 1) {
        path.push('value');
      }
      newMap = objectify(newMap, path, targetMap[k]);
    }
  }
  return newMap;
}



function expandVar(val, mapping, mirror) {
  if (mirror === undefined || mirror === false){
    if (typeof val === 'string') {
        Object.keys(mapping).forEach(function(p) {

            val = val.replace(
                new RegExp('\\$\\{' + p + '\\}', 'g'),
                mapping[p]
            );

        });
        val = val.replace(/\$\{\w*\}/g, '[?]');
    }
    return val;
  } else {
    return JSON.stringify(unflattenMap(mapping.ev));
  }
}

function expandObject(templateObj, dictionary, mirror) {
    var res = {};
    if (templateObj && typeof templateObj === 'object') {
      if (mirror === undefined || mirror === false) {
        Object.keys(templateObj).forEach(function(key) {
            if (typeof templateObj[key] === 'string') {
                res[expandVar(key, dictionary)] = expandVar(templateObj[key], dictionary);
            } else if (typeof templateObj[key] === 'object') {
                res[expandVar(key, dictionary)] = expandObject(templateObj[key], dictionary);
            }
        });
      } else {
        Object.keys(dictionary).forEach(function(key) {
          res[key] = unflattenMap(dictionary[key]);
        });
      }
    }
    return res;
}

// Think better if this is the best way
function flattenMap(key, targetMap) {
    var newMap = {}, v, flattened, fv;
    Object.keys(targetMap).forEach(function(k) {
        v = targetMap[k];
        if (v && typeof v === 'object') {
            flattened = flattenMap(k + '__', v);
            Object.keys(flattened).forEach(function(fk) {
                fv = flattened[fk];
                newMap[key + fk] = fv;
            });
        } else {
            newMap[key + k] = v;
        }
    });
    return newMap;
}


function requestHelperAux(method, options, withMetrics, callback) {
    var localError, respObj, headers,
        domain = process.domain;
    logger.info('making %s to %s', method, options.url);
    if (withMetrics && domain.context) {
        metrics.IncMetrics(domain.context.srv, domain.context.subsrv, metrics.outgoingTransactions);
    }
    headers = options.headers || {};
    if (domain && domain.context) {
        headers[constants.CORRELATOR_HEADER] = domain.context.corr;
        if (domain.context.srv && headers[constants.SERVICE_HEADER] === undefined) {
            headers[constants.SERVICE_HEADER] = domain.context.srv;
        }
        if (domain.context.subsrv && headers[constants.SUBSERVICE_HEADER] === undefined) {
            headers[constants.SUBSERVICE_HEADER] = domain.context.subsrv;
        }
        if (domain.context.from && headers[constants.REALIP_HEADER] === undefined) {
            headers[constants.REALIP_HEADER] = domain.context.from;
        }
    }
    options.headers = headers;
    if (withMetrics && options.json && domain.context) {
        try {
            metrics.IncMetrics(domain.context.srv, domain.context.subsrv, metrics.outgoingTransactionsRequestSize,
                Buffer.byteLength(JSON.stringify(options.body), 'utf-8'));
        } catch (exception) {
            logger.warn(exception);
        }
    }
    request[method](options, function cbRequest2core(err, response, body) {
        var bodySz = 0;
        if (withMetrics && domain.context) {
            if (body) {
                if (typeof body === 'string') {
                    bodySz = Buffer.byteLength(body);
                } else {
                    try {
                        bodySz = Buffer.byteLength(JSON.stringify(body));
                    } catch (ex) {
                        logger.warn(ex);
                    }
                }
                metrics.IncMetrics(domain.context.srv, domain.context.subsrv,
                    metrics.outgoingTransactionsResponseSize, bodySz);
            }
        }
        if (err) {
            logErrorIf(err, util.format('error %s to %s', method, options.url));
            if (withMetrics && domain.context) {
                metrics.IncMetrics(domain.context.srv, domain.context.subsrv, metrics.outgoingTransactionsErrors);
            }
            return callback(err, null);
        }
        respObj = {code: response.statusCode, body: body};
        logger.debug('%s to %s returns %j', method, options.url, respObj);
        if (response.statusCode < 200 || response.statusCode >= 300) {
            localError = new Error(util.format('error %s to %s (%s)', method, options.url,
                (body && body.error) || (body && JSON.stringify(body)) || response.statusCode));
            localError.httpCode = 500;
            logErrorIf(localError, domain && domain.context);
            if (withMetrics && domain.context) {
                metrics.IncMetrics(domain.context.srv, domain.context.subsrv, metrics.outgoingTransactionsErrors);
            }
            return callback(localError, respObj);
        }
        logger.info('done %s to %s', method, options.url);
        return callback(err, respObj);
    });
}

function requestHelper(method, options, callback) {
    return requestHelperAux(method, options, true, callback);
}

function requestHelperWOMetrics(method, options, callback) {
    return requestHelperAux(method, options, false, callback);
}

function respondAux(resp, err, data, withCount, raw, withMetrics) {
    var statusCode = 200,
        errMsg = null,
        respObj, respStr,
        domain = process.domain;
    if (err) {
        errMsg = err.message;
        statusCode = err.httpCode || 500;
        data = null;
    }

    if (raw === true) {
        if (err) {
            respObj = err;
            delete respObj.httpCode;
        } else {
            respObj = data;
        }

    }
    else { // non-raw
        respObj = {error: errMsg, data: data};
        if (withCount === true && data && util.isArray(data)) {
            respObj.count = data.length;
        }
    }
    logger.info('sending response: %s %j', statusCode,
        respObj);
    respStr = JSON.stringify(respObj);
    if (withMetrics && domain && domain.context) {
        metrics.IncMetrics(domain.context.srv, domain.context.subsrv,
            metrics.incomingTransactionsResponseSize, Buffer.byteLength(respStr, 'utf-8'));
        if (err) {
            metrics.IncMetrics(domain.context.srv, domain.context.subsrv, metrics.incomingTransactionsErrors);
        }
    }
    resp.set('Content-Type', 'application/json');
    resp.status(statusCode);
    resp.send(respStr);
}

function respond(resp, err, data, withCount, raw) {
    return respondAux(resp, err, data, withCount, raw, true);
}

function respondWOMetrics(resp, err, data, withCount, raw, withMetrics) {
    return respondAux(resp, err, data, withCount, raw, false);
}

function firstChars(result) {
    var text;
    if (result === undefined) {
        result = 'undefined';
    }
    text = JSON.stringify(result);
    if (text.length > 125) {
        text = text.substr(0, 125) + ' [...]';
    }
    return text;
}

function purgeName(name) {
    return name ? name.replace(/\//g, '$') : name;
}

function contextName(rule) {
    return util.format('ctxt$%s%s', purgeName(rule.service), purgeName(rule.subservice));
}

function ruleUniqueName(rule) {
    return util.format('%s@%s%s', rule.name, rule.service, rule.subservice);
}

function contextEPL(rule) {
    return util.format('create context %s partition by service from iotEvent(service="%s" and subservice="%s")',
        contextName(rule), rule.service, rule.subservice);
}

function ruleWithContext(rule) {
    return util.format('context %s %s', contextName(rule), rule.text);
}

/**
 * expandVar substitutes every variable in val (denoted as $(var}) with the value
 * in mappings (as dictionary), getting the key 'var' from the object
 *
 * @param  {string}   'template' in which to replace variables for values
 * @param  {Object}   variable name to substitute
 */
module.exports.expandVar = expandVar;

module.exports.expandObject = expandObject;

/**
 * flattenMap flatten a map recursively using '__' to nested maps
 *
 * @param  {string} key to append to every nested key
 * @param  {Object} object to put the flattened keys
 */
module.exports.flattenMap = flattenMap;

/**
 * requestHelper makes an HTTP request.
 *
 * @param {string}       method  ('GET', 'POST', 'PUT', 'DELETE')
 * @param {Object}       options, as accepted by 'request' library
 * @param {function}     callback function(error, response)
 */
module.exports.requestHelper = requestHelper;
module.exports.requestHelperWOMetrics = requestHelperWOMetrics;

/**
 * respond sends an HTTP response with the proper code for the error passed in, if any.
 * Also it can add the length if the object to send is in Array and it is asked for.
 *
 * @param {Object}       response object form Express
 * @param {Object}       error object or null
 * @param {Object}       data to send as JSON
 * @param {boolean}      if data is an Array, add a count field with its length
 */
module.exports.respond = respond;
module.exports.respondWOMetrics = respondWOMetrics;

/**
 * logErrorIf writes an error if passed in. Optionally a message can be add and the level for log can be set
 *
 * @param {Object}       error, if null, nothing will be logged
 * @param {string}       message to add, optional
 * @param {string}       level to log to, optional. 'error' by default
 */
module.exports.logErrorIf = logErrorIf;
/**
 * firstChars returns first characters of a string
 *
 * @param  {string} string to trim, if necessary
 */
module.exports.firstChars = firstChars;
/**
 * ruleUniqueName returns a unique name for a rule, including subservice and service names
 *
 * @param  {Object} Object rule
 */
module.exports.ruleUniqueName = ruleUniqueName;

/**
 * ruleWithContext returns the text of a rule with the context information add (currently the text)
 *
 * @param  {Object} Object rule
 */
module.exports.ruleWithContext = ruleWithContext;
/**
 * contextRuleText returns the EPL text for creating a context for subservice and service names
 *
 * @param  {Object} Object rule
 */
module.exports.contextEPL = contextEPL;

/**
 * contextRuleName returns the name of a context for subservice and service names
 *
 * @param  {Object} Object rule
 */
module.exports.contextName = contextName;
