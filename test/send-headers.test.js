'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const Fastify = require('fastify')
const fastifySSE = require('../index.js')

test('reply.sse.sendHeaders() should send headers manually', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    reply.header('X-Manual-Header', 'manual-value')
    reply.header('X-Custom-ID', '12345')

    // Manually call sendHeaders before sending any data
    reply.sse.sendHeaders()

    await reply.sse.send({ data: 'hello after manual headers' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['x-manual-header'], 'manual-value')
  assert.strictEqual(response.headers['x-custom-id'], '12345')

  const body = response.body
  assert.ok(body.includes('data: "hello after manual headers"'))
})

test('reply.sse.sendHeaders() should be idempotent', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    reply.header('X-Idempotent-Test', 'test-value')

    // Call sendHeaders multiple times - should be safe
    reply.sse.sendHeaders()
    reply.sse.sendHeaders()
    reply.sse.sendHeaders()

    await reply.sse.send({ data: 'message after multiple sendHeaders calls' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['x-idempotent-test'], 'test-value')

  const body = response.body
  assert.ok(body.includes('data: "message after multiple sendHeaders calls"'))
})

test('reply.sse.sendHeaders() should transfer all reply headers to raw response', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    // Set various types of headers
    reply.header('X-Single-Header', 'single-value')
    reply.headers({
      'X-Multi-Header-1': 'multi1',
      'X-Multi-Header-2': 'multi2'
    })
    reply.type('text/event-stream')

    // Manually send headers
    reply.sse.sendHeaders()

    // Set more headers after sendHeaders (these won't be sent)
    reply.header('X-After-Headers', 'after-value')

    await reply.sse.send({ data: 'test' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)

  // Headers set before sendHeaders() should be present
  assert.strictEqual(response.headers['x-single-header'], 'single-value')
  assert.strictEqual(response.headers['x-multi-header-1'], 'multi1')
  assert.strictEqual(response.headers['x-multi-header-2'], 'multi2')
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')

  // Headers set after sendHeaders() should NOT be present
  assert.strictEqual(response.headers['x-after-headers'], undefined)
})

test('reply.sse.sendHeaders() should work with preHandler hooks', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', {
    sse: true,
    preHandler: async (request, reply) => {
      reply.header('X-PreHandler-Header', 'prehandler-value')
    }
  }, async (request, reply) => {
    reply.header('X-Handler-Header', 'handler-value')

    // Manually send headers
    reply.sse.sendHeaders()

    await reply.sse.send({ data: 'prehandler test' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['x-prehandler-header'], 'prehandler-value')
  assert.strictEqual(response.headers['x-handler-header'], 'handler-value')

  const body = response.body
  assert.ok(body.includes('data: "prehandler test"'))
})

test('reply.sse.sendHeaders() should preserve default SSE headers', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    // Call sendHeaders without setting any custom headers
    reply.sse.sendHeaders()

    await reply.sse.send({ data: 'default headers preserved' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)

  // Default SSE headers should still be present
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.strictEqual(response.headers['cache-control'], 'no-cache')
  assert.strictEqual(response.headers['connection'], 'keep-alive')
  assert.strictEqual(response.headers['x-accel-buffering'], 'no')
})

test('headers should still work when sendHeaders() is not called manually', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    reply.header('X-Auto-Header', 'auto-value')

    // Don't call sendHeaders manually - should be called automatically
    await reply.sse.send({ data: 'automatic headers' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['x-auto-header'], 'auto-value')

  const body = response.body
  assert.ok(body.includes('data: "automatic headers"'))
})

test('reply.sse.sendHeaders() should work with keepAlive()', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    reply.header('X-KeepAlive-Header', 'keepalive-value')

    reply.sse.sendHeaders()
    reply.sse.keepAlive()

    // Send a message after headers are sent
    setTimeout(async () => {
      await reply.sse.send({ data: 'delayed message' })
      reply.sse.close()
    }, 50)
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['x-keepalive-header'], 'keepalive-value')

  const body = response.body
  assert.ok(body.includes('data: "delayed message"'))
})
