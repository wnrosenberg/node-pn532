'use strict';
var util = require('util');

var c = require('./constants');

var PREAMBLE     = 0x00;
var START_CODE_1 = 0x00;
var START_CODE_2 = 0xFF;
var POSTAMBLE    = 0x00;

var curTime = () => { // @WNR
    let cur = new Date();
    return "[" + cur.getHours() + ":" + cur.getMinutes() + ":" +
           cur.getSeconds() + "." + cur.getMilliseconds() + "] ";
}

/*
    Represents a single communication frame for communication with the PN532 NFC Chip.
*/
class Frame {
    // Gets the frame's data length
    getFrameLength() {
        throw new Error(curTime() + 'Implement in subclass');
    }

    // Convert Frame instance to a Buffer instance
    toBuffer() {
        throw new Error(curTime() + 'Implement in subclass');
    }

    [util.inspect.custom]() {
        return util.format('<Frame>');
    }

    static fromBuffer(buffer) {
        if (AckFrame.isFrame(buffer)) {
            return new AckFrame();
        }

        if (NackFrame.isFrame(buffer)) {
            return new NackFrame();
        }

        if (ErrorFrame.isFrame(buffer)) {
            return new ErrorFrame();
        }

        if (DataFrame.isFrame(buffer)) {
            return new DataFrame(buffer);
        }

        throw new Error(curTime() + 'Invalid Response');
    }

    static isFrame(buffer) {
        return DataFrame.isFrame(buffer) ||
               AckFrame.isFrame(buffer) ||
               NackFrame.isFrame(buffer) ||
               ErrorFrame.isFrame(buffer);
    }
}

class DataFrame extends Frame {
    /*
        Constructor

        @param {(bufer|array}} data - Complete packet data, or just the data portion of the package data
        @param {number} [direction=DIRECTION_HOST_TO_PN532] - Way of message (PN532 to HOST, or HOST to PN532.  See DIRECTION_* constants)
    */
    constructor(data, direction) {
        super();
        if (data instanceof Buffer) {
            var buffer = data;

            var d, dir;
            var dataLength = 0;
            var dataStart = 0;
            var dataEnd = 0;

            if (Frame.isFrame(data)) {
                this.bufferType = "frame";

                // Only buffers that are frames follow these rules.
                dataLength = buffer[3];
                dataStart = 6;
                dataEnd = dataStart + dataLength;
                d = new Buffer(dataLength);
                dir = buffer[5];
            } else {
                this.bufferType = "apdu";

                // Buffers apparently can also be straight up APDUs
                // (without the [00,ff,00, ... 00] frame wrapper)
                dataLength = buffer.length;
                dataStart = 0;
                dataEnd = dataStart + dataLength;
                d = new Buffer(dataLength);
                dir = c.DIRECTION_PN532_TO_HOST;
                // likley an APDU sending from the PN532 to the Android HCE, although this is a guess.
            }
            console.log(curTime() + 'dataLength, start, end');
            console.log(dataLength);
            console.log(dataStart);
            console.log(dataEnd);
            buffer.copy(d, 0, dataStart, dataEnd);

            this._data = d;
            this.direction = dir;
        } else if (data instanceof Array) {
            this._data = data;
            this._direction = direction || c.DIRECTION_HOST_TO_PN532;
        } else {
            throw new Error(curTime() + 'data must be an instanceof a Buffer or Array');
        }
    }

    toJSON() {
        return {
            direction: this.getDirection(),
            data: {
                command: this.getDataCommand(),
                body: this.getDataBody(),
                // checksum: this.getDataChecksum(),
                // length: this.getDataLength(),
                // lengthChecksum: this.getDataLengthChecksum()
            },
        };
    }

    [util.inspect.custom]() {
        return util.format('<DataFrame %j>', this.toJSON());
    }

    // Gets the frame's direction
    getDirection() {
        return this._direction;
    }

    // Gets the frame's data
    getData() {
        return this._data;
    }

    getDataCommand() {
        if (this.bufferType === "frame") {
            // The command for this frame.
            return this._data[0];
        } else if (this.bufferType === "apdu") {
            return this._data[1]; // the INS byte
        }
    }

    getDataBody() {
        if (this.bufferType === "frame") {
            // The command for this frame.
            return this._data.slice(1);
        } else if (this.bufferType === "apdu") {
            return this._data.slice(); // the INS byte
        }
    }

    // Gets the frame's data length
    getDataLength() {
        return this._data.length + 1;
    }

    // Gets the checksum of getDataLength().
    getDataLengthChecksum() {
        return (~this.getDataLength() & 0xFF) + 0x01;
    }

    // Gets a checksum for the frame's data.
    getDataChecksum() {
        var dataCopy = this._data.slice();
        if (!Array.isArray(dataCopy)) dataCopy = new Array();
        dataCopy.push(this._direction);

        var sum = dataCopy.reduce((prev,current) => prev + current);
        var inverse = (~sum & 0xFF) + 0x01;

        if (inverse > 255) {
            inverse = inverse - 255;
        }

        return inverse;
    }

    getFrameLength() {
        var frameLengthMinusData = 7;
        return this._data.length + frameLengthMinusData;
    }

    static isFrame(buffer) {
        // Checks if a buffer from the PN532 is valid.
        var frameLengthMinusData = 7;
        if (buffer.length <= frameLengthMinusData) {
            return false;
        }

        var dataLength = buffer[3];
        var validFrameLength = frameLengthMinusData + dataLength;
        if (buffer.length < validFrameLength) {
            return false;
        }

        // TODO: Check LCS and DCS checksums

        return (buffer[0] === PREAMBLE &&
                buffer[1] === START_CODE_1 &&
                buffer[2] === START_CODE_2 &&
                buffer[validFrameLength - 1] === 0x00);
    }

    toBuffer() {
        var array = [].concat([
            PREAMBLE,
            START_CODE_1,
            START_CODE_2,
            this.getDataLength(),
            this.getDataLengthChecksum(),
            this.getDirection()
        ],  this._data, [
            this.getDataChecksum(),
            POSTAMBLE
        ]);
        return new Buffer(array);
    }
}

class AckFrame extends Frame {
    constructor() {
        super();
    }

    getFrameLength() {
        return 6;
    }

    static isFrame(buffer) {
        // Checks if the buffer is an ACK frame. [00 00 FF 00 FF 00]
        return (buffer.length >= 6 &&
                buffer[0] === PREAMBLE &&
                buffer[1] === START_CODE_1 &&
                buffer[2] === START_CODE_2 &&
                buffer[3] === 0x00 &&
                buffer[4] === 0xFF &&
                buffer[5] === POSTAMBLE);
    }

    toBuffer() {
        return new Buffer([
            PREAMBLE,
            START_CODE_1,
            START_CODE_2,
            0x00,
            0xFF,
            POSTAMBLE
        ]);
    }

    [util.inspect.custom]() {
        return util.format('<AckFrame %j>', this.toBuffer());
    }
}

class NackFrame extends Frame {
    constructor() {
        super();
    }

    getFrameLength() {
        return 6;
    }

    static isFrame(buffer) {
        // Checks if the buffer is an NACK frame. [00 00 FF FF 00 00]
        return (buffer.length >= 6 &&
                buffer[0] === PREAMBLE &&
                buffer[1] === START_CODE_1 &&
                buffer[2] === START_CODE_2 &&
                buffer[3] === 0xFF &&
                buffer[4] === 0x00 &&
                buffer[5] === POSTAMBLE);

    }

    toBuffer() {
        return new Buffer([
            PREAMBLE,
            START_CODE_1,
            START_CODE_2,
            0xFF,
            0x00,
            POSTAMBLE
        ]);
    }

    [util.inspect.custom]() {
        return util.format('<NackFrame %j>', this.toBuffer());
    }
}

class ErrorFrame extends DataFrame {
    constructor() {
        super([0x7F]);
    }

    static isFrame(buffer) {
        //  Checks if the buffer is an error frame. [00 00 FF 01 FF 7F 81 00]
        return (buffer.length >= 8 &&
                buffer[0] === PREAMBLE &&
                buffer[1] === START_CODE_1 &&
                buffer[2] === START_CODE_2 &&
                buffer[3] === 0x01 && // Packet length
                buffer[4] === 0xFF && // Packet length checksum
                buffer[5] === 0x7F && // Specific application level error code
                buffer[6] === 0x81 && // Packet data checksum
                buffer[7] === POSTAMBLE);
    }

    toBuffer() {
        return new Buffer([
            PREAMBLE,
            START_CODE_1,
            START_CODE_2,
            0x01,    // Packet length
            0xFF,    // Packet length checksum
            0x7F,    // Specific application level error code
            0x81,    // Packet data checksum
            POSTAMBLE
        ]);
    }
}

exports.Frame = Frame;
exports.DataFrame = DataFrame;
exports.AckFrame = AckFrame;
exports.NackFrame = NackFrame;
exports.ErrorFrame = ErrorFrame;
