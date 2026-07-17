'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const Fastify = require('fastify')
const fastifySSE = require('../index.js')

test('SSE response should default to status 200', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.ok(response.body.includes('data: "hello"'))
})

test('reply.code() before first SSE write should set the response status', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    reply.code(201)
    await reply.sse.send({ data: 'created' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.statusCode, 201)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.ok(response.body.includes('data: "created"'))
})

test('reply.sse.sendHeaders(statusCode) should set the response status', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    reply.sse.sendHeaders(202)
    await reply.sse.send({ data: 'accepted' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.statusCode, 202)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.ok(response.body.includes('data: "accepted"'))
})

test('explicit sendHeaders(statusCode) should take precedence over reply.code()', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    reply.code(201)
    reply.sse.sendHeaders(202)
    await reply.sse.send({ data: 'accepted' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.statusCode, 202)
})

test('status changes after headers are committed should have no effect', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    await reply.sse.send({ data: 'first' })
    reply.sse.sendHeaders(500)
    await reply.sse.send({ data: 'second' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.ok(response.body.includes('data: "first"'))
  assert.ok(response.body.includes('data: "second"'))
})
