'use strict';

const { Buffer } = require('buffer');
const { FastBuffer } = require('internal/buffer');
const {
  WriteWrap,
  kReadBytesOrError,
  kArrayBufferOffset,
  kBytesWritten,
  kLastWriteWasAsync,
  streamBaseState
} = internalBinding('stream_wrap');
const { UV_EOF } = internalBinding('uv');
const { errnoException } = require('internal/errors');
const { owner_symbol } = require('internal/async_hooks').symbols;

const kMaybeDestroy = Symbol('kMaybeDestroy');
const kUpdateTimer = Symbol('kUpdateTimer');

function handleWriteReq(req, data, encoding) {
  const { handle } = req;

  switch (encoding) {
    case 'buffer':
    {
      const ret = handle.writeBuffer(req, data);
      if (streamBaseState[kLastWriteWasAsync])
        req.buffer = data;
      return ret;
    }
    case 'latin1':
    case 'binary':
      return handle.writeLatin1String(req, data);
    case 'utf8':
    case 'utf-8':
      return handle.writeUtf8String(req, data);
    case 'ascii':
      return handle.writeAsciiString(req, data);
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return handle.writeUcs2String(req, data);
    default:
    {
      const buffer = Buffer.from(data, encoding);
      const ret = handle.writeBuffer(req, buffer);
      if (streamBaseState[kLastWriteWasAsync])
        req.buffer = buffer;
      return ret;
    }
  }
}

function createWriteWrap(handle, oncomplete) {
  var req = new WriteWrap();

  req.handle = handle;
  req.oncomplete = oncomplete;
  req.async = false;
  req.bytes = 0;
  req.buffer = null;

  return req;
}

function writevGeneric(self, req, data, cb) {
  var allBuffers = data.allBuffers;
  var chunks;
  var i;
  if (allBuffers) {
    chunks = data;
    for (i = 0; i < data.length; i++)
      data[i] = data[i].chunk;
  } else {
    chunks = new Array(data.length << 1);
    for (i = 0; i < data.length; i++) {
      var entry = data[i];
      chunks[i * 2] = entry.chunk;
      chunks[i * 2 + 1] = entry.encoding;
    }
  }
  var err = req.handle.writev(req, chunks, allBuffers);

  // Retain chunks
  if (err === 0) req._chunks = chunks;

  afterWriteDispatched(self, req, err, cb);
}

function writeGeneric(self, req, data, encoding, cb) {
  var err = handleWriteReq(req, data, encoding);

  afterWriteDispatched(self, req, err, cb);
}

function afterWriteDispatched(self, req, err, cb) {
  req.bytes = streamBaseState[kBytesWritten];
  req.async = !!streamBaseState[kLastWriteWasAsync];

  if (err !== 0)
    return self.destroy(errnoException(err, 'write', req.error), cb);

  if (!req.async) {
    cb();
  } else {
    req.callback = cb;
  }
}

function onStreamRead(arrayBuffer) {
  const nread = streamBaseState[kReadBytesOrError];

  const handle = this;
  const stream = this[owner_symbol];

  stream[kUpdateTimer]();

  if (nread > 0 && !stream.destroyed) {
    const offset = streamBaseState[kArrayBufferOffset];
    const buf = new FastBuffer(arrayBuffer, offset, nread);
    if (!stream.push(buf)) {
      handle.reading = false;
      if (!stream.destroyed) {
        const err = handle.readStop();
        if (err)
          stream.destroy(errnoException(err, 'read'));
      }
    }

    return;
  }

  if (nread === 0) {
    return;
  }

  if (nread !== UV_EOF) {
    return stream.destroy(errnoException(nread, 'read'));
  }

  // defer this until we actually emit end
  if (stream._readableState.endEmitted) {
    if (stream[kMaybeDestroy])
      stream[kMaybeDestroy]();
  } else {
    if (stream[kMaybeDestroy])
      stream.on('end', stream[kMaybeDestroy]);

    // push a null to signal the end of data.
    // Do it before `maybeDestroy` for correct order of events:
    // `end` -> `close`
    stream.push(null);
    stream.read(0);
  }
}

module.exports = {
  createWriteWrap,
  writevGeneric,
  writeGeneric,
  onStreamRead,
  kMaybeDestroy,
  kUpdateTimer,
};
