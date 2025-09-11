'use strict'

const fastify = require('fastify')({ logger: true })

// Register the SSE plugin
fastify.register(require('../index.js'))

// Basic SSE endpoint
fastify.get('/events', { sse: true }, async (request, reply) => {
  // Send a simple message
  await reply.sse.send({ data: 'Hello SSE!' })

  // Send multiple events
  for (let i = 0; i < 5; i++) {
    await reply.sse.send({
      id: String(i),
      event: 'counter',
      data: { count: i, timestamp: Date.now() }
    })
  }

  // Connection will close automatically when handler ends
})

// Stream endpoint with async generator
fastify.get('/stream', { sse: true }, async (request, reply) => {
  async function * generateEvents () {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      yield {
        id: String(i),
        event: 'tick',
        data: { tick: i, time: new Date().toISOString() }
      }
    }
  }

  await reply.sse.send(generateEvents())
})

// Persistent connection with keepAlive
fastify.get('/live', { sse: true }, async (request, reply) => {
  // Keep connection alive
  reply.sse.keepAlive()

  // Send initial event
  await reply.sse.send({ data: 'Connected to live stream' })

  // Send periodic updates
  const interval = setInterval(async () => {
    try {
      if (reply.sse.isConnected) {
        await reply.sse.send({
          event: 'heartbeat',
          data: { timestamp: Date.now() }
        })
      } else {
        clearInterval(interval)
      }
    } catch (error) {
      clearInterval(interval)
    }
  }, 2000)

  // Clean up on close
  reply.sse.onClose(() => {
    clearInterval(interval)
    console.log('Live stream connection closed')
  })
})

// Custom headers with sendHeaders
fastify.get('/headers', { sse: true }, async (request, reply) => {
  // Set custom headers using Fastify's header methods
  reply.header('X-Session-ID', 'session-12345')
  reply.header('X-API-Version', 'v1.2.3')
  reply.headers({
    'X-User-Agent': request.headers['user-agent'] || 'unknown',
    'X-Request-Time': new Date().toISOString()
  })

  // Manually send headers before any SSE data
  reply.sse.sendHeaders()

  // Now send SSE data
  await reply.sse.send({
    data: 'Headers sent manually before this message',
    event: 'custom-headers'
  })
})

// Replay functionality
const messageHistory = []
let eventId = 0

fastify.get('/replay', { sse: true }, async (request, reply) => {
  // Handle replay if client reconnects
  await reply.sse.replay(async (lastEventId) => {
    const startIndex = messageHistory.findIndex(msg => msg.id === lastEventId)
    const messagesToReplay = startIndex !== -1
      ? messageHistory.slice(startIndex + 1)
      : messageHistory

    for (const message of messagesToReplay) {
      await reply.sse.send(message)
    }
  })

  // Send new message
  const newMessage = {
    id: String(++eventId),
    data: { message: `New event ${eventId}`, timestamp: Date.now() }
  }

  messageHistory.push(newMessage)

  // Keep only last 100 messages
  if (messageHistory.length > 100) {
    messageHistory.shift()
  }

  await reply.sse.send(newMessage)
})

// Start the server
const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' })
    console.log('Server listening on http://localhost:3000')
    console.log('Try these endpoints:')
    console.log('  GET /events - Basic SSE messages')
    console.log('  GET /stream - Streaming with async generator')
    console.log('  GET /live - Persistent connection with heartbeat')
    console.log('  GET /headers - Custom headers with sendHeaders()')
    console.log('  GET /replay - Messages with replay support')
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
