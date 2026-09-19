'use strict';

// Vercel Serverless Function entrypoint
const server = require('../server/index');

module.exports = (req, res) => {
  server.emit('request', req, res);
};
