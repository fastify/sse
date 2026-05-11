'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const Fastify = require('fastify')
const { Readable } = require('stream')
const fastifySSE = require('../index.js')
const { clientAcceptsSSE } = require('../index.js')

test('basic SSE functionality', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

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
    await reply.sse.send({
      id: '123',
      event: 'update',
      data: { message: 'test' },
      retry: 1000
    })
  })

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
    await reply.sse.send('plain text message')
  })

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
    await reply.sse.send({ data: 'line1\nline2\nline3' })
  })

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
    async function * generate () {
      yield { id: '1', data: 'first' }
      yield { id: '2', data: 'second' }
      yield { id: '3', data: 'third' }
    }

    await reply.sse.send(generate())
  })

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

    await reply.sse.send(stream)
  })

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
      await reply.sse.send({ data: 'sse data' })
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
    await reply.sse.send({ data: 'test' })
  })

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

test('reply.sse.stream() for pipeline operations', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/pipeline', { sse: true }, async (request, reply) => {
    const { pipeline } = require('stream/promises')

    // Create a source stream with test data
    const sourceStream = Readable.from([
      { id: '1', data: 'first' },
      { id: '2', data: 'second' },
      { id: '3', data: 'third' }
    ])

    // Use reply.sse.stream() in a pipeline
    await pipeline(sourceStream, reply.sse.stream(), reply.raw, { end: false })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/pipeline',
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

test('clientAcceptsSSE: missing Accept admits SSE', () => {
  assert.strictEqual(clientAcceptsSSE(undefined), true)
  assert.strictEqual(clientAcceptsSSE(''), true)
})

test('clientAcceptsSSE: */* admits SSE', () => {
  assert.strictEqual(clientAcceptsSSE('*/*'), true)
  assert.strictEqual(clientAcceptsSSE('application/json, */*'), true)
})

test('clientAcceptsSSE: text/* admits SSE', () => {
  assert.strictEqual(clientAcceptsSSE('text/*'), true)
})

test('clientAcceptsSSE: explicit text/event-stream admits SSE', () => {
  assert.strictEqual(clientAcceptsSSE('text/event-stream'), true)
  assert.strictEqual(clientAcceptsSSE('text/event-stream;charset=utf-8'), true)
})

test('clientAcceptsSSE: explicit non-matching types do not admit SSE', () => {
  assert.strictEqual(clientAcceptsSSE('application/json'), false)
  assert.strictEqual(clientAcceptsSSE('text/html, text/plain'), false)
})

test('clientAcceptsSSE: q=0 on most specific match overrides wildcards', () => {
  // RFC 9110: the most specific match wins. text/event-stream;q=0 explicitly
  // rejects SSE even though */* would otherwise admit it.
  assert.strictEqual(clientAcceptsSSE('*/*, text/event-stream;q=0'), false)
  assert.strictEqual(clientAcceptsSSE('text/*, text/event-stream;q=0'), false)
})

test('clientAcceptsSSE: q=0 on wildcard does not block explicit match', () => {
  assert.strictEqual(clientAcceptsSSE('*/*;q=0, text/event-stream'), true)
})

test('clientAcceptsSSE: q-values are parsed but do not affect admission past 0', () => {
  assert.strictEqual(clientAcceptsSSE('text/event-stream;q=0.1'), true)
  assert.strictEqual(clientAcceptsSSE('application/json;q=0.9, */*;q=0.1'), true)
})

test('clientAcceptsSSE: out-of-range q-values are ignored (default q=1)', () => {
  // q=2 / q=-1 / q=abc are invalid per RFC 9110; entry falls back to q=1
  // and still admits SSE.
  assert.strictEqual(clientAcceptsSSE('text/event-stream;q=2'), true)
  assert.strictEqual(clientAcceptsSSE('text/event-stream;q=-1'), true)
  assert.strictEqual(clientAcceptsSSE('text/event-stream;q=abc'), true)
  // Invalid q on the most specific match doesn't unblock SSE if a valid
  // qvalue elsewhere makes the entry inadmissible. Here q=2 is invalid →
  // defaults to 1 → still admits.
  assert.strictEqual(clientAcceptsSSE('*/*;q=2'), true)
})

test('SSE is served when client sends Accept: */*', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: '*/*'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.ok(response.body.includes('data: "hello"'))
})

test('SSE is served when client omits the Accept header', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events'
    // no Accept header
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.ok(response.body.includes('data: "hello"'))
})

test('SSE is served when client sends Accept: text/*', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: {
      accept: 'text/*'
    }
  })

  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
})

test('clientAcceptsSSE: strict mode only admits explicit text/event-stream', () => {
  const strict = { strict: true }
  assert.strictEqual(clientAcceptsSSE(undefined, strict), false)
  assert.strictEqual(clientAcceptsSSE('', strict), false)
  assert.strictEqual(clientAcceptsSSE('*/*', strict), false)
  assert.strictEqual(clientAcceptsSSE('text/*', strict), false)
  assert.strictEqual(clientAcceptsSSE('application/json', strict), false)
  assert.strictEqual(clientAcceptsSSE('text/event-stream', strict), true)
  assert.strictEqual(clientAcceptsSSE('application/json, text/event-stream', strict), true)
  assert.strictEqual(clientAcceptsSSE('text/event-stream;q=0', strict), false)
  assert.strictEqual(clientAcceptsSSE('text/event-stream;q=0.5', strict), true)
})

test('plugin-level strictAccept opts out of the SSE-wins default', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE, { strictAccept: true })

  fastify.get('/data', { sse: true }, async (request, reply) => {
    if (reply.sse) {
      await reply.sse.send({ data: 'streamed' })
    } else {
      return { message: 'json' }
    }
  })

  // */* now falls back because strictAccept refuses ambiguous headers
  const wildcard = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: '*/*' }
  })
  assert.strictEqual(wildcard.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepStrictEqual(JSON.parse(wildcard.body), { message: 'json' })

  // Explicit text/event-stream still gets SSE
  const explicit = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/event-stream' }
  })
  assert.strictEqual(explicit.headers['content-type'], 'text/event-stream')
  assert.ok(explicit.body.includes('data: "streamed"'))
})

test('route-level strictAccept overrides plugin-level setting', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  // Plugin default: lenient
  await fastify.register(fastifySSE)

  // Per-route override: strict
  fastify.get('/strict', {
    sse: { strictAccept: true }
  }, async (request, reply) => {
    if (reply.sse) {
      await reply.sse.send({ data: 'streamed' })
    } else {
      return { message: 'json' }
    }
  })

  // Default route uses plugin default (admits SSE for */*)
  fastify.get('/default', { sse: true }, async (request, reply) => {
    await reply.sse.send({ data: 'streamed' })
  })

  const strictWildcard = await fastify.inject({
    method: 'GET',
    url: '/strict',
    headers: { accept: '*/*' }
  })
  assert.strictEqual(strictWildcard.headers['content-type'], 'application/json; charset=utf-8')

  const defaultWildcard = await fastify.inject({
    method: 'GET',
    url: '/default',
    headers: { accept: '*/*' }
  })
  assert.strictEqual(defaultWildcard.headers['content-type'], 'text/event-stream')
})

test('handler can gate fallback on reply.sse presence', async (t) => {
  const fastify = Fastify({ logger: false })

  t.after(async () => {
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/data', { sse: true }, async (request, reply) => {
    if (reply.sse) {
      await reply.sse.send({ data: 'streamed' })
    } else {
      return { message: 'json' }
    }
  })

  // */* → plugin admits SSE → handler sees reply.sse and streams
  const sseResponse = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: '*/*' }
  })
  assert.strictEqual(sseResponse.headers['content-type'], 'text/event-stream')
  assert.ok(sseResponse.body.includes('data: "streamed"'))

  // application/json → plugin falls back → handler returns JSON
  const jsonResponse = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json' }
  })
  assert.strictEqual(jsonResponse.statusCode, 200)
  assert.strictEqual(jsonResponse.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepStrictEqual(JSON.parse(jsonResponse.body), { message: 'json' })
})
