'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;

var setupLogging = require('./logs');
setupLogging(process.env.PN532_LOGGING);
var logger = require('winston').loggers.get('pn532');

var FrameEmitter = require('./frame_emitter').FrameEmitter;
var frame = require('./frame');
var DataFrame = frame.DataFrame;
var AckFrame = frame.AckFrame;
var c = require('./constants');

var curTime = () => { // @WNR
    let cur = new Date();
    return "[" + cur.getHours() + ":" + cur.getMinutes() + ":" +
           cur.getSeconds() + "." + cur.getMilliseconds() + "] ";
}

class PN532 extends EventEmitter {
    /*
        @constructor
        @param {object} hal - An instance of node-serialport's SerialPort or node-i2c's i2c
    */
    constructor(hal, options) {
        super();
        options = options || {};
        this.pollInterval = options.pollInterval || 1000;

        if (hal.constructor.name === 'SerialPort') {
            var PN532_UART = require('./pn532_uart');
            this.hal = new PN532_UART(hal);
        } else if (hal.constructor.name === 'i2c') {
            var PN532_I2C = require('./pn532_i2c');
            this.hal = new PN532_I2C(hal);
        } else {
            throw new Error(curTime() + 'Unknown hardware type: ', hal.constructor.name);
        }

        this.frameEmitter = new FrameEmitter(this.hal);
        this.hal.init().then(() => {
            this.configureSecureAccessModule().then(() => this.emit('ready'));
        });

        this.on('newListener', (event) => {
            // TODO: Only poll once (for each event type)
            if (event === 'tag') {
                logger.debug(curTime() + 'Polling for tag scans...');
                var scanTag = () => {
                    this.scanTag().then((tag) => {
                        this.emit('tag', tag);
                        setTimeout(() => scanTag(), this.pollInterval);
                    });
                };
                scanTag();
            }
        });
    }

    sendCommand(commandBuffer) {
        return new Promise((resolve, reject) => {

            var removeListeners = () => {
                logger.debug(curTime() + 'Removing listeners');
                this.frameEmitter.removeListener('frame', onFrame);
                this.frameEmitter.removeListener('error', onError);
            };

            // Wire up listening to wait for response (or error) from PN532
            var onFrame = (frame) => {
                logger.debug(curTime() + 'Response received for sendCommand', util.inspect(frame));
                // TODO: If no ACK after 15ms, resend? (page 40 of user guide, UART only)?

                if (frame instanceof AckFrame) {
                    logger.info(curTime() + 'Command Acknowledged', util.inspect(frame));
                } else if (frame instanceof DataFrame) {
                    logger.info(curTime() + 'Command Response', util.inspect(frame));
                    removeListeners();
                    resolve(frame);
                }
            };
            this.frameEmitter.on('frame', onFrame);

            var onError = (error) => {
                logger.error(curTime() + 'Error received for sendCommand', error);
                removeListeners();
                reject(error);
            };
            this.frameEmitter.on('error', onError);

            // Send command to PN532
            var dataFrame = new DataFrame(commandBuffer);
            var buffer = dataFrame.toBuffer();
            logger.debug(curTime() + 'Sending buffer:', util.inspect(buffer));
            this.hal.write(buffer);
        });
    }

    configureSecureAccessModule() {
        logger.info(curTime() + 'Configuring secure access module (SAM)...');

        // TODO: Test IRQ triggered reads

        var timeout = 0x00;  // 0x00-0xFF (12.75 seconds).  Only valid for Virtual card mode (SAMCONFIGURATION_MODE_VIRTUAL_CARD)

        var commandBuffer = [
            c.COMMAND_SAMCONFIGURATION,
            c.SAMCONFIGURATION_MODE_NORMAL,
            timeout,
            c.SAMCONFIGURATION_IRQ_ON // Use IRQ pin
        ];
        return this.sendCommand(commandBuffer);
    }

    getFirmwareVersion() {
        logger.info(curTime() + 'Getting firmware version...');

        return this.sendCommand([c.COMMAND_GET_FIRMWARE_VERSION])
            .then((frame) => {
                var body = frame.getDataBody();
                return {
                    IC: body[0],
                    Ver: body[1],
                    Rev: body[2],
                    Support: body[3]
                };
            });
    }

    getGeneralStatus() {
        logger.info(curTime() + 'Getting general status...');

        return this.sendCommand([c.COMMAND_GET_GENERAL_STATUS])
            .then((frame) => {
                var body = frame.getDataBody();
                return body;
            });
    }

    scanTag() {
        logger.info(curTime() + 'Scanning tag...');

        var maxNumberOfTargets = 0x01;
        var baudRate = c.CARD_ISO14443A;

        var commandBuffer = [
            c.COMMAND_IN_LIST_PASSIVE_TARGET,
            maxNumberOfTargets,
            baudRate
        ];

        return this.sendCommand(commandBuffer)
            .then((frame) => {
                var body = frame.getDataBody();
                logger.debug('body', util.inspect(body));

                var numberOfTags = body[0];
                if (numberOfTags === 1) {
                    var tagNumber = body[1];
                    var uidLength = body[5];

                    var uid = body.slice(6, 6 + uidLength)
                                  .toString('hex')
                                  .match(/.{1,2}/g)
                                  .join(':');

                    return {
                        ATQA: body.slice(2, 4), // SENS_RES
                        SAK: body[4],           // SEL_RES
                        uid: uid
                    };
                }
            });
    }

    readBlock(options) {
        logger.info(curTime() + 'Reading block...');

        var options = options || {};

        var tagNumber = options.tagNumber || 0x01;
        var blockAddress = options.blockAddress || 0x01;

        var commandBuffer = [
            c.COMMAND_IN_DATA_EXCHANGE,
            tagNumber,
            c.MIFARE_COMMAND_READ,
            blockAddress,
        ];

        return this.sendCommand(commandBuffer)
            .then((frame) => {
                var body = frame.getDataBody();
                logger.debug(curTime() + 'Frame data from block read:', util.inspect(body));

                var status = body[0];

                if (status === 0x13) {
                    logger.warn(curTime() + 'The data format does not match to the specification.');
                }
                var block = body.slice(1, body.length - 1); // skip status byte and last byte (not part of memory)
                // var unknown = body[body.length];

                return block;
        });
    }

    readNdefData() {
        logger.info(curTime() + 'Reading data...');

        return this.readBlock({blockAddress: 0x04})
            .then((block) => {
                logger.debug(curTime() + 'block:', util.inspect(block));

                // Find NDEF TLV (0x03) in block of data - See NFC Forum Type 2 Tag Operation Section 2.4 (TLV Blocks)
                var ndefValueOffset = null;
                var ndefLength = null;
                var blockOffset = 0;

                while (ndefValueOffset === null) {
                    logger.debug(curTime() + 'blockOffset:', blockOffset, 'block.length:', block.length);
                    if (blockOffset >= block.length) {
                        throw new Error(curTime() + 'Unable to locate NDEF TLV (0x03) byte in block:', block)
                    }

                    var type = block[blockOffset];       // Type of TLV
                    var length = block[blockOffset + 1]; // Length of TLV
                    logger.debug(curTime() + 'blockOffset', blockOffset);
                    logger.debug(curTime() + 'type', type, 'length', length);

                    if (type === c.TAG_MEM_NDEF_TLV) {
                        logger.debug('NDEF TLV found');
                        ndefLength = length;                  // Length proceeds NDEF_TLV type byte
                        ndefValueOffset = blockOffset + 2;    // Value (NDEF data) proceeds NDEV_TLV length byte
                        logger.debug(curTime() + 'ndefLength:', ndefLength);
                        logger.debug(curTime() + 'ndefValueOffset:', ndefValueOffset);
                    } else {
                        // Skip TLV (type byte, length byte, plus length of value)
                        blockOffset = blockOffset + 2 + length;
                    }
                }

                var ndefData = block.slice(ndefValueOffset, block.length);
                var additionalBlocks = Math.ceil((ndefValueOffset + ndefLength) / 16) - 1;
                logger.debug(curTime() + 'Additional blocks needing to retrieve:', additionalBlocks);

                // Sequentially grab each additional 16-byte block (or 4x 4-byte pages) of data, chaining promises
                var self = this;
                var allDataPromise = (function retrieveBlock(blockNum) {
                    if (blockNum <= additionalBlocks) {
                        var blockAddress = 4 * (blockNum + 1);
                        logger.debug(curTime() + 'Retrieving block:', blockNum, 'at blockAddress:', blockAddress);
                        return self.readBlock({blockAddress: blockAddress})
                            .then(function(block) {
                                blockNum++;
                                ndefData = Buffer.concat([ndefData, block]);
                                return retrieveBlock(blockNum);
                            });
                    }
                })(1);

                return allDataPromise.then(() => ndefData.slice(0, ndefLength));
            })
            .catch(function(error) {
                logger.error(curTime() + 'ERROR:', error);
            });
    }

    writeBlock(block, options) {
        logger.info(curTime() + 'Writing block...');

        var options = options || {};

        var tagNumber = options.tagNumber || 0x01;
        var blockAddress = options.blockAddress || 0x01;

        var commandBuffer = [].concat([
            c.COMMAND_IN_DATA_EXCHANGE,
            tagNumber,
            c.MIFARE_COMMAND_WRITE_4,
            blockAddress
        ],  block);

        return this.sendCommand(commandBuffer)
            .then((frame) => {
                var body = frame.getDataBody();
                logger.debug(curTime() + 'Frame data from block write:', util.inspect(body));

                var status = body[0];

                if (status === 0x13) {
                    logger.warn(curTime() + 'The data format does not match to the specification.');
                }
                var block = body.slice(1, body.length - 1); // skip status byte and last byte (not part of memory)
                // var unknown = body[body.length];

                return block;
            });
    }

    writeNdefData(data) {
        logger.info(curTime() + 'Writing data...');

        // Prepend data with NDEF type and length (TLV) and append terminator TLV
        var block = [].concat([
            c.TAG_MEM_NDEF_TLV,
            data.length
        ],  data, [
            c.TAG_MEM_TERMINATOR_TLV
        ]);

        logger.debug(curTime() + 'block:', util.inspect(new Buffer(block)));

        var PAGE_SIZE = 4;
        var totalBlocks = Math.ceil(block.length / PAGE_SIZE);

        // Sequentially write each additional 4-byte pages of data, chaining promises
        var self = this;
        var allPromises = (function writeBlock(blockNum) {
            if (blockNum < totalBlocks) {
                var blockAddress = 0x04 + blockNum;
                var pageData = block.splice(0, PAGE_SIZE);

                if (pageData.length < PAGE_SIZE) {
                    pageData.length = PAGE_SIZE; // Setting length will make sure NULL TLV (0x00) are written at the end of the page
                }

                logger.debug(curTime() + 'Writing block:', blockNum, 'at blockAddress:', blockAddress);
                logger.debug(curTime() + 'pageData:', util.inspect(new Buffer(pageData)));
                return self.writeBlock(pageData, {blockAddress: blockAddress})
                .then(function(block) {
                    blockNum++;
                    // ndefData = Buffer.concat([ndefData, block]);
                    return writeBlock(blockNum);
                });
            }
        })(0);

        // return allDataPromise.then(() => ndefData.slice(0, ndefLength));
        return allPromises;
    }

    // WIP
    authenticateBlock(uid, options) {
        logger.info(curTime() + 'Authenticating block...');

        var options = options || {};

        var blockAddress = options.blockAddress || 0x04;
        var authType = options.authType || c.MIFARE_COMMAND_AUTH_A
        var authKey = options.authKey || [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
        var tagNumber = options.tagNumber || 0x01;
        var uidArray = uid.split(':').map(s => Number('0x' + s));

        var commandBuffer = [
            c.COMMAND_IN_DATA_EXCHANGE,
            tagNumber,
            authType,
            blockAddress
        ].concat(authKey).concat(uidArray);

        return this.sendCommand(commandBuffer)
        .then((frame) => {
            var body = frame.getDataBody();
            logger.info(curTime() + 'Frame data from mifare classic authenticate', util.inspect(body));

            console.log(curTime() + 'body', body);
            return body;

            // var status = body[0];
            // var tagData = body.slice(1, body.length);

            // return {
            //     status: status.toString(16),
            //     tagData: tagData
            // };
        });
    }
}

exports.PN532 = PN532;
exports.I2C_ADDRESS = c.I2C_ADDRESS;
