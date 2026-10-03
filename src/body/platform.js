'use strict'

// Keyboard/mouse backend for real-client mode on this OS.
if (process.platform === 'win32') module.exports = require('./win32')
else if (process.platform === 'linux') module.exports = require('./linux')
else throw new Error(`real-client mode runs on Windows or Linux, not ${process.platform}`)
