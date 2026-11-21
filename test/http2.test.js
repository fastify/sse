'use strict'

const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const { connect } = require('node:http2')
const { once } = require('node:events')
const Fastify = require('fastify')
const fastifySSE = require('../index.js')

test('should not send the Connection header over HTTP/2', async (t) => {
  const warnings = []
  const onWarning = (warning) => warnings.push(warning)
  process.on('warning', onWarning)

  const fastify = Fastify({ logger: false, http2: true })

  t.after(async () => {
    process.off('warning', onWarning)
    await fastify.close()
  })

  await fastify.register(fastifySSE)

  fastify.get('/events', { sse: true }, async (request, reply) => {
    await reply.sse.send({ data: 'hello' })
  })

  await fastify.listen({ port: 0 })

  const client = connect(`http://localhost:${fastify.server.address().port}`)
  t.after(() => client.close())

  const stream = client.request({ ':path': '/events', accept: 'text/event-stream' })
  stream.setEncoding('utf8')

  const [headers] = await once(stream, 'response')
  let body = ''
  for await (const chunk of stream) {
    body += chunk
  }

  assert.strictEqual(headers[':status'], 200)
  assert.strictEqual(headers['content-type'], 'text/event-stream')
  assert.strictEqual(headers.connection, undefined)
  assert.ok(body.includes('data: "hello"'))

  // Let a pending process 'warning' event fire before checking
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(warnings.filter((w) => w.name === 'UnsupportedWarning'), [])
})
