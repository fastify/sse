'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const Fastify = require('fastify')
const fastifySSE = require('../index.js')

// `sse: 'manual'` attaches reply.sse without Accept-header negotiation and
// lets the handler decide at runtime whether to stream. This mirrors the way
// OpenAI-style / LLM APIs signal streaming through the request body rather
// than the Accept header.

test('manual mode streams when the handler chooses to (no Accept header)', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(() => fastify.close())

  await fastify.register(fastifySSE)

  fastify.post('/v1/chat', { sse: 'manual' }, async (request, reply) => {
    if (request.body.stream) {
      await reply.sse.send({ data: 'chunk-1' })
      await reply.sse.send({ data: 'chunk-2' })
      return
    }
    return { content: 'full response' }
  })

  const streamed = await fastify.inject({
    method: 'POST',
    url: '/v1/chat',
    payload: { stream: true }
  })

  assert.strictEqual(streamed.statusCode, 200)
  assert.strictEqual(streamed.headers['content-type'], 'text/event-stream')
  assert.ok(streamed.body.includes('data: "chunk-1"'))
  assert.ok(streamed.body.includes('data: "chunk-2"'))
})

test('manual mode falls back to a normal JSON response without streaming', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(() => fastify.close())

  await fastify.register(fastifySSE)

  fastify.post('/v1/chat', { sse: 'manual' }, async (request, reply) => {
    if (request.body.stream) {
      await reply.sse.send({ data: 'chunk' })
      return
    }
    return { content: 'full response' }
  })

  const json = await fastify.inject({
    method: 'POST',
    url: '/v1/chat',
    payload: { stream: false }
  })

  assert.strictEqual(json.statusCode, 200)
  assert.match(json.headers['content-type'], /application\/json/)
  assert.notStrictEqual(json.headers['content-type'], 'text/event-stream')
  assert.deepStrictEqual(json.json(), { content: 'full response' })
})

test('manual mode streams regardless of an Accept header that refuses SSE', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(() => fastify.close())

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'manual' }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  // Accept: application/json would 406 on an `only` route and skip SSE on a
  // `dual` route; `manual` ignores it entirely.
  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: 'application/json' }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.ok(response.body.includes('data: "hello"'))
})

test('manual mode closes the stream after the handler resolves', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(() => fastify.close())

  await fastify.register(fastifySSE)

  let closed = false
  fastify.get('/events', { sse: 'manual' }, async (request, reply) => {
    reply.sse.onClose(() => { closed = true })
    await reply.sse.send({ data: 'one' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events'
  })

  assert.strictEqual(response.statusCode, 200)
  assert.ok(response.body.includes('data: "one"'))
  // inject resolves only once the response stream has ended.
  assert.strictEqual(closed, true)
})

test('manual mode closes the stream when the handler throws', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(() => fastify.close())

  await fastify.register(fastifySSE)

  let closed = false
  fastify.get('/events', { sse: 'manual' }, async (request, reply) => {
    reply.sse.onClose(() => { closed = true })
    await reply.sse.send({ data: 'before error' })
    throw new Error('boom')
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events'
  })

  // Headers were already committed as SSE before the throw, so the partial
  // stream is flushed and the connection is closed during cleanup.
  assert.ok(response.body.includes('data: "before error"'))
  assert.strictEqual(closed, true)
})

test('manual mode respects keepAlive() (no auto-close after handler)', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(() => fastify.close())

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'manual' }, async (request, reply) => {
    reply.sse.keepAlive()
    await reply.sse.send({ data: 'first' })

    setTimeout(async () => {
      await reply.sse.send({ data: 'second' })
      reply.sse.close()
    }, 30)
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events'
  })

  assert.strictEqual(response.statusCode, 200)
  assert.ok(response.body.includes('data: "first"'))
  assert.ok(response.body.includes('data: "second"'))
})

test("manual mode via object form ({ kind: 'manual' })", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(() => fastify.close())

  await fastify.register(fastifySSE)

  fastify.get('/events', {
    sse: { kind: 'manual', serializer: (data) => `CUSTOM:${JSON.stringify(data)}` }
  }, async (request, reply) => {
    await reply.sse.send({ data: 'test' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events'
  })

  assert.strictEqual(response.statusCode, 200)
  assert.ok(response.body.includes('CUSTOM:"test"'))
})

test('a non-SSE fallback response is not corrupted by a heartbeat', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(() => fastify.close())

  // A 1ms heartbeat would fire during the handler if it were started eagerly.
  await fastify.register(fastifySSE, { heartbeatInterval: 1 })

  fastify.post('/v1/chat', { sse: 'manual' }, async (request, reply) => {
    // Give the (deferred) heartbeat timer a chance to fire before returning.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { content: 'full response' }
  })

  const response = await fastify.inject({
    method: 'POST',
    url: '/v1/chat',
    payload: { stream: false }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.match(response.headers['content-type'], /application\/json/)
  assert.deepStrictEqual(response.json(), { content: 'full response' })
})
