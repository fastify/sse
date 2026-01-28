'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const Fastify = require('fastify')

async function runTest (SSE, t) {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(SSE)
  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse.send({ data: 'hello world' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.strictEqual(response.headers['cache-control'], 'no-cache')
  assert.strictEqual(response.headers.connection, 'keep-alive')

  const { body: responseBody } = response
  assert.ok(responseBody.includes('data: "hello world"'))
  assert.ok(responseBody.endsWith('\n\n'))
}

test('module import', async (t) => {
  const fastifySSE = require('../index.js')
  await runTest(fastifySSE, t)
})

test('default import', async (t) => {
  const { default: fastifySSE } = require('../index.js')
  await runTest(fastifySSE, t)
})

test('named import', async (t) => {
  const { fastifySSE } = require('../index.js')
  await runTest(fastifySSE, t)
})
