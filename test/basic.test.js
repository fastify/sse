'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const Fastify = require('fastify')
const { Readable } = require('stream')
const fastifySSE = require('../index.js')

test('basic SSE functionality', async (t) => {
  const fastify = Fastify({ logger: false })
  
  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse({ data: 'hello world' })
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
  assert.strictEqual(response.headers['cache-control'], 'no-cache')
  assert.strictEqual(response.headers['connection'], 'keep-alive')
  
  const body = response.body
  assert.ok(body.includes('data: "hello world"'))
  assert.ok(body.endsWith('\n\n'))
})

test('SSE message formatting', async (t) => {
  const fastify = Fastify({ logger: false })
  
  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse({
      id: '123',
      event: 'update',
      data: { message: 'test' },
      retry: 1000
    })
  })

  await fastify.listen({ port: 0 })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  const body = response.body
  assert.ok(body.includes('id: 123'))
  assert.ok(body.includes('event: update'))
  assert.ok(body.includes('data: {"message":"test"}'))
  assert.ok(body.includes('retry: 1000'))
})

test('string message support', async (t) => {
  const fastify = Fastify({ logger: false })
  
  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse('plain text message')
  })

  await fastify.listen({ port: 0 })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  const body = response.body
  assert.ok(body.includes('data: plain text message'))
})

test('multiline data handling', async (t) => {
  const fastify = Fastify({ logger: false })
  
  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse({ data: 'line1\nline2\nline3' })
  })

  await fastify.listen({ port: 0 })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  const body = response.body
  assert.ok(body.includes('data: "line1\\nline2\\nline3"'))
})

test('async generator support', async (t) => {
  const fastify = Fastify({ logger: false })
  
  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/stream', { sse: true }, async (request, reply) => {
    async function* generate () {
      yield { id: '1', data: 'first' }
      yield { id: '2', data: 'second' }
      yield { id: '3', data: 'third' }
    }

    await reply.sse(generate())
  })

  await fastify.listen({ port: 0 })

  const response = await fastify.inject({
    method: 'GET',
    url: '/stream',
    headers: {
      accept: 'text/event-stream'
    }
  })

  const body = response.body
  assert.ok(body.includes('id: 1'))
  assert.ok(body.includes('data: "first"'))
  assert.ok(body.includes('id: 2'))
  assert.ok(body.includes('data: "second"'))
  assert.ok(body.includes('id: 3'))
  assert.ok(body.includes('data: "third"'))
})

test('readable stream support', async (t) => {
  const fastify = Fastify({ logger: false })
  
  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/stream', { sse: true }, async (request, reply) => {
    const stream = Readable.from([
      { id: 'a', data: 'alpha' },
      { id: 'b', data: 'beta' },
      { id: 'c', data: 'gamma' }
    ])

    await reply.sse(stream)
  })

  await fastify.listen({ port: 0 })

  const response = await fastify.inject({
    method: 'GET',
    url: '/stream',
    headers: {
      accept: 'text/event-stream'
    }
  })

  const body = response.body
  assert.ok(body.includes('id: a'))
  assert.ok(body.includes('data: "alpha"'))
  assert.ok(body.includes('id: b'))
  assert.ok(body.includes('data: "beta"'))
})

test('fallback to regular handler when SSE not requested', async (t) => {
  const fastify = Fastify({ logger: false })
  
  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    // Only use SSE if the accept header is for SSE
    const acceptHeader = request.headers.accept || ''
    if (acceptHeader.includes('text/event-stream')) {
      await reply.sse({ data: 'sse data' })
    } else {
      return { message: 'regular response' }
    }
  })

  await fastify.listen({ port: 0 })

  // Request without SSE accept header
  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'application/json'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
  
  const body = JSON.parse(response.body)
  assert.deepStrictEqual(body, { message: 'regular response' })
})

test('custom serializer', async (t) => {
  const fastify = Fastify({ logger: false })
  
  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE, {
    serializer: (data) => `custom:${data}`
  })

  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse({ data: 'test' })
  })

  await fastify.listen({ port: 0 })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/event-stream'
    }
  })

  const body = response.body
  assert.ok(body.includes('data: custom:test'))
})