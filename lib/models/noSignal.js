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

var util = require('util'),
    domain = require('domain'),
    logger = require('logops'),
    myutils = require('../myutils'),
    entitiesStore = require('./entitiesStore'),
    actions = require('./actions'),
    nsRulesByInterval = {},
    checkers = {},
    intervalUnit = 1000 * 60,
    TENANT = 0,
    SERVICE = 1,
    NAME = 2,
    ATTRIBUTE = 3,
    ID = 4,
    ID_REGEXP = 5,
    TYPE = 6,
    REPORT_INTERVAL = 7,
    context = {op: 'checkNonSignal'},
    lastTime;

function alertFunc(nsLineRule, entity) {
    var d = domain.create();

    d.on('error', function(err) {
        myutils.logErrorIf(err);
        d.exit();
    });
    d.run(function() {
        // We duplicate info in event and event.ev for VR and non-VR action parameters
        var event = {
            tenant: nsLineRule[TENANT],
            service: nsLineRule[SERVICE],
            ruleName: nsLineRule[NAME],
            reportInterval: nsLineRule[REPORT_INTERVAL],
            id: entity._id.id,
            type: entity._id.type
        };
        event.ev = {
            tenant: nsLineRule[TENANT],
            service: nsLineRule[SERVICE],
            ruleName: nsLineRule[NAME],
            reportInterval: nsLineRule[REPORT_INTERVAL],
            id: entity._id.id,
            type: entity._id.type
        };

        //Search for modDate of the entity's attributes
        if (util.isArray(entity.attrs)) {
            for (var i = 0; i < entity.attrs.length; i++) {
                if (entity.attrs[i].name === nsLineRule[ATTRIBUTE]) {
                    try {
                        lastTime = (new Date(entity.attrs[i].modDate * 1000)).toISOString();
                    } catch (ex) {
                        myutils.logErrorIf(ex);
                    }
                    break;
                }
            }
        }
        logger.debug('lastTime could be ', lastTime);
        if (lastTime !== undefined && lastTime !== null) {
            event.lastTime = event.ev.lastTime = lastTime;
        }
        event = myutils.flattenMap('', event);
        actions.Do(event, function(err) {
            myutils.logErrorIf(JSON.stringify(err));
        });
    });
}

function checkNoSignal(period) {
    var list = nsRulesByInterval[period] || [];
    logger.debug(context, 'Executing no-signal handler for period of %d (%d rules)', period, list.length);
    list.forEach(function(nsrule, i) {
        entitiesStore.FindSilentEntities(nsrule[TENANT], nsrule[SERVICE],
            {attribute: nsrule[ATTRIBUTE],
                id: nsrule[ID],
                idRegexp: nsrule[ID_REGEXP],
                type: nsrule[TYPE],
                reportInterval: nsrule[REPORT_INTERVAL]
            },
            alertFunc.bind({}, nsrule),
            function(err, data) {
                myutils.logErrorIf(err);
                logger.debug(context, 'silent entities: ', data);
            });
    });
}

function nsr2arr(tenant, service, name, nsr) {
    var arrayRule = [];
    arrayRule[SERVICE] = service;
    arrayRule[TENANT] = tenant;
    arrayRule[NAME] = name;
    arrayRule[ATTRIBUTE] = nsr.attribute;
    arrayRule[ID] = nsr.id;
    arrayRule[ID_REGEXP] = nsr.idRegexp;
    arrayRule[TYPE] = nsr.type;
    arrayRule[REPORT_INTERVAL] = nsr.reportInterval;
    return arrayRule;
}

function addNSRule(tenant, service, name, nsr) {
    var arrayRule,
        alreadyExists = false;
    arrayRule = nsr2arr(tenant, service, name, nsr);
    nsRulesByInterval[nsr.checkInterval] = nsRulesByInterval[nsr.checkInterval] || [];
    nsRulesByInterval[nsr.checkInterval].forEach(function(element, index, array) {
        if (element[NAME] === name && element[TENANT] === tenant && element[SERVICE] === service) {
            array[index] = arrayRule; //Update rule
            alreadyExists = true;
            logger.debug(context, util.format('Updating no-signal rule (%s, %s, %s)', tenant, service, name));
        }
    });
    if (!alreadyExists) {
        nsRulesByInterval[nsr.checkInterval].push(arrayRule);
        logger.debug(context, util.format('Adding no-signal rule (%s, %s, %s)', tenant, service, name));
    }
    if (!checkers.hasOwnProperty(nsr.checkInterval)) {
        checkers[nsr.checkInterval] = setInterval(checkNoSignal, nsr.checkInterval * intervalUnit, nsr.checkInterval);
        checkers[nsr.checkInterval].unref();
    }
}
function deleteNSRule(tenant, service, name) {
    Object.keys(nsRulesByInterval).forEach(function(chkInt) {
        var line = nsRulesByInterval[chkInt] || [];
        line.forEach(function(element, index) {
            if (element[NAME] === name && element[TENANT] === tenant && element[SERVICE] === service) {
                line.splice(index, 1);
                if (line.length === 0) { // There are no rules left for this interval
                    if (checkers.hasOwnProperty(chkInt)) {
                        clearInterval(checkers[chkInt]);
                        delete checkers[chkInt];
                    }
                }
                // Don't break, just in case a duplicated rule slipped inside (horror!)
                logger.debug(context, util.format('Deleting no-signal rule (%s, %s, %s)', tenant, service, name));
            }
        });
    });
}

function refreshAllRules(rules) {
    var count = 0;
    logger.debug('Refreshing all no-signal rules');
    rules.forEach(function(rule) {
        if (rule.nosignal) {
            addNSRule(rule.tenant, rule.service, rule.name, rule.nosignal);
            count++;
        }
    });
    logger.debug(context, util.format('no-signal rules %d/%d, checkers: %d',
        count, rules.length, Object.keys(checkers).length));
}

module.exports.AddNSRule = addNSRule;
module.exports.DeleteNSRule = deleteNSRule;
module.exports.RefreshAllRules = refreshAllRules;
module.exports.CheckNoSignal = checkNoSignal;
