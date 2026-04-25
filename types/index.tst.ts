'use strict'

import fastify, { FastifyRequest, FastifyReply, FastifyInstance, RouteShorthandOptions } from 'fastify'
import fastifySSE, { SSEPluginOptions, SSEMessage, SSESource, SSEReplyInterface } from '.'
import { Readable } from 'stream'
import { expect } from 'tstyche'

// Test plugin registration
const app: FastifyInstance = fastify()

// Test plugin options - app.register returns the app instance
expect(app.register(fastifySSE)).type.toBeAssignableTo<FastifyInstance>()
expect(app.register(fastifySSE, {})).type.toBeAssignableTo<FastifyInstance>()
expect(app.register(fastifySSE, {
  heartbeatInterval: 10000
})).type.toBeAssignableTo<FastifyInstance>()
expect(app.register(fastifySSE, {
  serializer: (data: any) => JSON.stringify(data)
})).type.toBeAssignableTo<FastifyInstance>()
expect(app.register(fastifySSE, {
  heartbeatInterval: 0,
  serializer: (data: any) => String(data)
})).type.toBeAssignableTo<FastifyInstance>()

// Test invalid plugin options
expect(app.register).type.not.toBeCallableWith(fastifySSE, {
  heartbeatInterval: 'invalid'
})

expect(app.register).type.not.toBeCallableWith(fastifySSE, {
  serializer: 123
})

expect(app.register).type.not.toBeCallableWith(fastifySSE, {
  unknownOption: true
})

// Test route options
app.get('/sse', { sse: true }, async (request, reply) => {
  expect(reply.sse).type.toBe<SSEReplyInterface>()
  return reply.sse.send({ data: 'test' })
})

app.get('/sse-with-options', {
  sse: {
    heartbeat: true,
    serializer: (data: any) => JSON.stringify(data)
  }
}, async (request, reply) => {
  expect(reply.sse).type.toBe<SSEReplyInterface>()
  return reply.sse.send({ data: 'test' })
})

// Test SSE message types
const message: SSEMessage = {
  data: 'test'
}

const fullMessage: SSEMessage = {
  id: '123',
  event: 'custom',
  data: { foo: 'bar' },
  retry: 5000
}

expect(message.id).type.toBe<string | undefined>()
expect(message.event).type.toBe<string | undefined>()
expect(message.data).type.toBe<any>()
expect(message.retry).type.toBe<number | undefined>()
expect(fullMessage).type.toBeAssignableTo<SSEMessage>()

// Test SSE sources
const stringSource: SSESource = 'hello'
expect(stringSource).type.toBeAssignableTo<SSESource>()

const bufferSource: SSESource = Buffer.from('hello')
expect(bufferSource).type.toBeAssignableTo<SSESource>()

const messageSource: SSESource = { data: 'test' }
expect(messageSource).type.toBeAssignableTo<SSESource>()

const streamSource: SSESource = new Readable()
expect(streamSource).type.toBeAssignableTo<SSESource>()

async function * asyncGenerator (): AsyncIterable<SSEMessage> {
  yield { data: 'test' }
}
const asyncIterableSource: SSESource = asyncGenerator()
expect(asyncIterableSource).type.toBeAssignableTo<SSESource>()

// Test SSE reply interface
app.get('/test-reply', { sse: true }, async (request, reply) => {
  // Test properties
  expect(reply.sse.lastEventId).type.toBe<string | null>()
  expect(reply.sse.isConnected).type.toBe<boolean>()

  // Test send method with different sources
  expect(reply.sse.send('string')).type.toBe<Promise<void>>()
  expect(reply.sse.send(Buffer.from('buffer'))).type.toBe<Promise<void>>()
  expect(reply.sse.send({ data: 'object' })).type.toBe<Promise<void>>()
  expect(reply.sse.send(new Readable())).type.toBe<Promise<void>>()
  expect(reply.sse.send(asyncGenerator())).type.toBe<Promise<void>>()

  // Test stream method
  expect(reply.sse.stream()).type.toBe<NodeJS.WritableStream>()

  // Test keepAlive method
  expect(reply.sse.keepAlive()).type.toBe<void>()

  // Test close method
  expect(reply.sse.close()).type.toBe<void>()

  // Test replay method
  expect(reply.sse.replay(async (lastEventId: string) => {
    console.log(lastEventId)
  })).type.toBe<Promise<void>>()

  // Test onClose method
  expect(reply.sse.onClose(() => {
    console.log('closed')
  })).type.toBe<void>()
})

// Test that reply.sse is available only on sse routes
app.get('/no-sse', async (request, reply) => {
  // Note: reply.sse is added at runtime by the plugin, so we can't test its absence at compile time
  // This is expected behavior for Fastify plugins that decorate at runtime
})

// Test complex SSE message scenarios
const complexMessage: SSEMessage = {
  id: '456',
  event: 'update',
  data: {
    nested: {
      property: 'value',
      array: [1, 2, 3]
    }
  },
  retry: 10000
}

expect(complexMessage).type.toBeAssignableTo<SSESource>()

// Test async iterator types
async function * typedAsyncGenerator (): AsyncIterable<string> {
  yield 'test'
}

async function * mixedAsyncGenerator (): AsyncIterable<SSEMessage | string | Buffer> {
  yield { data: 'message' }
  yield 'string'
  yield Buffer.from('buffer')
}

expect(typedAsyncGenerator()).type.toBeAssignableTo<SSESource>()
expect(mixedAsyncGenerator()).type.toBeAssignableTo<SSESource>()

// Test plugin options interface
const pluginOptions: SSEPluginOptions = {
  heartbeatInterval: 15000,
  serializer: (data) => {
    expect(data).type.toBe<any>()
    return JSON.stringify(data)
  }
}
expect(pluginOptions).type.toBeAssignableTo<SSEPluginOptions>()

// Test serializer function type
const customSerializer = (data: any): string => {
  if (typeof data === 'object') {
    return JSON.stringify(data)
  }
  return String(data)
}
expect({
  serializer: customSerializer
}).type.toBeAssignableTo<SSEPluginOptions>()

// Test route options with boolean
const routeOptions1: RouteShorthandOptions = {
  sse: true
}
expect(routeOptions1).type.toBeAssignableTo<RouteShorthandOptions>()

const routeOptions2: RouteShorthandOptions = {
  sse: false
}
expect(routeOptions2).type.toBeAssignableTo<RouteShorthandOptions>()

const routeOptions3: RouteShorthandOptions = {
  sse: {
    heartbeat: false,
    serializer: (data) => String(data)
  }
}
expect(routeOptions3).type.toBeAssignableTo<RouteShorthandOptions>()

// Test invalid route options - these tests verify type checking
expect(app.get).type.not.toBeCallableWith('/invalid', {
  sse: 'invalid'
}, async (request: FastifyRequest, reply: FastifyReply) => {})

expect(app.get).type.not.toBeCallableWith('/invalid2', {
  sse: {
    unknownOption: true
  }
}, async (request: FastifyRequest, reply: FastifyReply) => { })
