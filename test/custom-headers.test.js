'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const Fastify = require('fastify')
const fastifySSE = require('../index.js')

test('should allow setting custom headers in SSE responses', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    // Set custom headers before sending SSE data
    reply.raw.setHeader('X-Session-ID', '12345')
    reply.raw.setHeader('X-API-Version', '1.0')
    reply.raw.setHeader('X-Custom-Header', 'test-value')

    await reply.sse.send({ data: 'hello' })
  })

  await fastify.listen({ port: 0 })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')

  // Check that custom headers are present
  assert.strictEqual(response.headers['x-session-id'], '12345')
  assert.strictEqual(response.headers['x-api-version'], '1.0')
  assert.strictEqual(response.headers['x-custom-header'], 'test-value')

  const body = response.body
  assert.ok(body.includes('data: "hello"'))
})

test('should allow setting headers via reply.header() method', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    // Use Fastify's header method
    reply.header('X-Request-ID', 'req-123')
    reply.header('X-User-ID', 'user-456')

    await reply.sse.send({ data: 'test' })
  })

  await fastify.listen({ port: 0 })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)

  // Check that headers set via reply.header() are present
  assert.strictEqual(response.headers['x-request-id'], 'req-123')
  assert.strictEqual(response.headers['x-user-id'], 'user-456')
})
