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

// -----------------------------------------------------------------------
// sse: 'only' (SSE-only routes)
// -----------------------------------------------------------------------

test("sse: 'only' admits SSE for */*", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: '*/*' }
  })
  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.ok(response.body.includes('data: "hello"'))
})

test("sse: 'only' admits SSE for missing Accept", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({ method: 'GET', url: '/events' })
  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
  assert.ok(response.body.includes('data: "hello"'))
})

test("sse: 'only' admits SSE for text/*", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: 'text/*' }
  })
  assert.strictEqual(response.headers['content-type'], 'text/event-stream')
})

test("sse: 'only' returns 406 when client explicitly refuses SSE", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: 'application/json' }
  })
  assert.strictEqual(response.statusCode, 406)
  assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(response.body)
  assert.strictEqual(body.statusCode, 406)
  assert.strictEqual(body.error, 'Not Acceptable')
  assert.match(body.message, /text\/event-stream/)
})

test("sse: 'only' returns 406 when client sends text/event-stream;q=0", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: 'only' }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: '*/*, text/event-stream;q=0' }
  })
  assert.strictEqual(response.statusCode, 406)
})

test("sse: { kind: 'only', heartbeat: false } object form is supported", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  fastify.get('/events', {
    sse: { kind: 'only', heartbeat: false }
  }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const wildcard = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: '*/*' }
  })
  assert.strictEqual(wildcard.headers['content-type'], 'text/event-stream')

  const refused = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: 'application/json' }
  })
  assert.strictEqual(refused.statusCode, 406)
})

// -----------------------------------------------------------------------
// sse: 'dual' (explicit dual-mode routes)
// -----------------------------------------------------------------------

test("sse: 'dual' routes only explicit text/event-stream to SSE", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  fastify.get('/data', { sse: 'dual' }, async (request, reply) => {
    if (reply.sse) {
      await reply.sse.send({ data: 'streamed' })
    } else {
      return { message: 'json' }
    }
  })

  // */* → falls through to JSON
  const wildcard = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: '*/*' }
  })
  assert.strictEqual(wildcard.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepStrictEqual(JSON.parse(wildcard.body), { message: 'json' })

  // missing → JSON
  const missing = await fastify.inject({ method: 'GET', url: '/data' })
  assert.deepStrictEqual(JSON.parse(missing.body), { message: 'json' })

  // application/json → JSON
  const jsonResponse = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json' }
  })
  assert.deepStrictEqual(JSON.parse(jsonResponse.body), { message: 'json' })

  // text/event-stream → SSE
  const explicit = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/event-stream' }
  })
  assert.strictEqual(explicit.headers['content-type'], 'text/event-stream')
  assert.ok(explicit.body.includes('data: "streamed"'))
})

// -----------------------------------------------------------------------
// sse: true (legacy back-compat + explanatory error on misuse)
// -----------------------------------------------------------------------

test("sse: true behaves like 'dual' for routing (back-compat)", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  fastify.get('/data', { sse: true }, async (request, reply) => {
    const acceptHeader = request.headers.accept || ''
    if (acceptHeader.includes('text/event-stream')) {
      await reply.sse.send({ data: 'streamed' })
    } else {
      return { message: 'json' }
    }
  })

  // */* → falls through (strict gate); handler returns JSON
  const wildcard = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: '*/*' }
  })
  assert.deepStrictEqual(JSON.parse(wildcard.body), { message: 'json' })

  // text/event-stream → SSE
  const explicit = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/event-stream' }
  })
  assert.strictEqual(explicit.headers['content-type'], 'text/event-stream')
})

test('sse: true with SSE-only handler emits an explanatory error on misuse', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  // Handler is SSE-only — calls reply.sse.send unconditionally — but
  // registered with the legacy `sse: true` flag. When a wildcard Accept
  // arrives, the strict gate falls through, reply.sse is undefined, and the
  // handler trips the TypeError. The plugin should rethrow with guidance to
  // switch to `sse: 'only'`.
  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: '*/*' }
  })

  // The rethrown error reaches Fastify's default error handler.
  assert.strictEqual(response.statusCode, 500)
  assert.match(response.body, /sse: 'only'/)
})

test('sse: true with object form (no kind) is treated as legacy', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  // No `kind` field — back-compat with existing `{ heartbeat, serializer }` users.
  fastify.get('/events', {
    sse: { heartbeat: false }
  }, async (request, reply) => {
    const acceptHeader = request.headers.accept || ''
    if (acceptHeader.includes('text/event-stream')) {
      await reply.sse.send({ data: 'streamed' })
    } else {
      return { message: 'json' }
    }
  })

  const wildcard = await fastify.inject({
    method: 'GET',
    url: '/events',
    headers: { accept: '*/*' }
  })
  assert.deepStrictEqual(JSON.parse(wildcard.body), { message: 'json' })
})

test('unknown sse kind throws at registration', async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => { await fastify.close() })
  await fastify.register(fastifySSE)

  assert.throws(
    () => fastify.get('/events', { sse: { kind: 'maybe' } }, async () => {}),
    /unknown sse kind 'maybe'/
  )
})

async function buildApp (t, options = {}) {
  const app = Fastify({ logger: false })

  t.after(async () => {
    await app.close()
  })

  await app.register(fastifySSE, options)
  return app
}

test('formats multiline Buffer messages', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse.send(Buffer.from('first\nsecond'))
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.body, 'data: first\ndata: second\n\n')
})

test('leaves ordinary routes alone and falls back when Accept is missing', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/plain', async () => ({ plain: true }))
  app.get('/events', { sse: true }, async (request, reply) => {
    return { fallback: reply.sse === undefined }
  })

  const plainResponse = await app.inject({ url: '/plain' })
  const fallbackResponse = await app.inject({ url: '/events' })

  assert.deepStrictEqual(plainResponse.json(), { plain: true })
  assert.deepStrictEqual(fallbackResponse.json(), { fallback: true })
})

test('parses SSE Accept parameters and optional whitespace', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/events', { sse: 'only' }, async (request, reply) => {
    await reply.sse.send({ data: 'accepted' })
  })

  const cases = [
    ['TEXT/EVENT-STREAM', 200],
    ['text/event-streax', 406],
    ['text/event-stream;q=', 200],
    ['text/event-stream;q=1', 200],
    ['text/event-stream;q=0.00', 406],
    ['text/event-stream;q=0.01', 200],
    ['text/event-stream ;q=0', 406],
    ['text/*;q=0', 406],
    ['application/json;foo=bar, text/event-stream', 200],
    ['text/event-stream; q=0', 406],
    ['text/event-stream;q=0;foo=bar', 406],
    ['text/event-stream;Q=0', 406]
  ]

  for (const [accept, expectedStatus] of cases) {
    const response = await app.inject({
      url: '/events',
      headers: { accept }
    })

    assert.strictEqual(response.statusCode, expectedStatus, accept)
  }
})

test('rejects unsupported route option values', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  assert.throws(
    () => app.get('/invalid', { sse: 42 }, async () => {}),
    /unsupported value for route option 'sse': 42/
  )
})

test('preserves legacy fallback errors and describes missing Accept misuse', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 0 })

  app.get('/misuse', { sse: true }, async (request, reply) => {
    await reply.sse.send({ data: 'value' })
  })

  app.get('/failure', { sse: true }, async () => {
    throw new Error('fallback failed')
  })

  const misuseResponse = await app.inject({ url: '/misuse' })
  const failureResponse = await app.inject({ url: '/failure' })

  assert.strictEqual(misuseResponse.statusCode, 500)
  assert.match(misuseResponse.body, /<missing>/)
  assert.strictEqual(failureResponse.statusCode, 500)
  assert.match(failureResponse.body, /fallback failed/)
})

test('supports route-level serializer and disabled heartbeat options', async (t) => {
  const app = await buildApp(t, { heartbeatInterval: 1 })
  let context

  app.get('/events', {
    sse: {
      heartbeat: false,
      serializer: (data) => `route:${data}`
    }
  }, async (request, reply) => {
    context = reply.sse
    reply.sse.keepAlive()
    await reply.sse.send({ data: 'value' })
    setTimeout(() => reply.sse.close(), 20)
  })

  const response = await app.inject({
    url: '/events',
    headers: { accept: 'text/event-stream' }
  })

  assert.strictEqual(response.body, 'data: route:value\n\n')
  assert.strictEqual(context.heartbeatTimer, null)
})
