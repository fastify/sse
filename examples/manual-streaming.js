'use strict'

/**
 * Dynamic streaming with @fastify/sse (`sse: 'manual'`)
 *
 * Some APIs — OpenAI-compatible and other LLM endpoints, for example —
 * decide whether to stream based on the request *body* (`{ "stream": true }`)
 * rather than the `Accept` header. `sse: 'manual'` skips Accept negotiation
 * entirely: `reply.sse` is always attached and the handler decides at runtime
 * whether to stream or to return a normal JSON response. The connection is
 * closed automatically when the handler resolves or throws.
 *
 * Test endpoints with curl:
 *
 * # Streaming response (Server-Sent Events):
 * curl -N -X POST http://localhost:3000/v1/chat/completions \
 *   -H "Content-Type: application/json" \
 *   -d '{"prompt":"hello","stream":true}'
 *
 * # Non-streaming response (single JSON object):
 * curl -X POST http://localhost:3000/v1/chat/completions \
 *   -H "Content-Type: application/json" \
 *   -d '{"prompt":"hello","stream":false}'
 *
 **/

async function buildServer () {
  const fastify = require('fastify')({ logger: true })

  await fastify.register(require('../index.js'))

  // A tiny stand-in for a model that emits tokens one at a time.
  async function * generateTokens (prompt) {
    const tokens = `Echo: ${prompt}`.split(' ')
    for (let i = 0; i < tokens.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 200))
      yield {
        id: String(i),
        event: 'token',
        data: { index: i, token: tokens[i] }
      }
    }
  }

  fastify.post('/v1/chat/completions', { sse: 'manual' }, async (request, reply) => {
    const { prompt = '', stream = false } = request.body ?? {}

    if (stream) {
      // Stream tokens as SSE. The SSE response headers are committed on the
      // first send(); the connection closes when this handler resolves.
      await reply.sse.send(generateTokens(prompt))
      await reply.sse.send({ event: 'done', data: '[DONE]' })
      return
    }

    // Non-streaming client — fall through to Fastify's normal JSON
    // serialization. `reply.sse` was attached but never written to, so no
    // SSE headers were sent.
    return {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: `Echo: ${prompt}` } }]
    }
  })

  return fastify
}

const start = async () => {
  const server = await buildServer()
  try {
    await server.listen({ port: 3000, host: '0.0.0.0' })
    console.log('Server listening on http://localhost:3000')
    console.log('Try POST /v1/chat/completions with {"stream": true} or {"stream": false}')
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
