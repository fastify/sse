import { expectType, expectError, expectAssignable } from 'tsd'
import fastify, { FastifyInstance, FastifyReply, RouteShorthandOptions } from 'fastify'
import fastifySSE, { SSEPluginOptions, SSEMessage, SSESource, SSEReplyInterface } from '..'
import { Readable } from 'stream'

// Test plugin registration
const app: FastifyInstance = fastify()

// Test plugin options - app.register returns the app instance
expectAssignable<FastifyInstance>(app.register(fastifySSE))
expectAssignable<FastifyInstance>(app.register(fastifySSE, {}))
expectAssignable<FastifyInstance>(app.register(fastifySSE, {
  heartbeatInterval: 10000
}))
expectAssignable<FastifyInstance>(app.register(fastifySSE, {
  serializer: (data: any) => JSON.stringify(data)
}))
expectAssignable<FastifyInstance>(app.register(fastifySSE, {
  heartbeatInterval: 0,
  serializer: (data: any) => String(data)
}))

// Test invalid plugin options  
expectError(app.register(fastifySSE, {
  heartbeatInterval: 'invalid'
}))
expectError(app.register(fastifySSE, {
  serializer: 123
}))
expectError(app.register(fastifySSE, {
  unknownOption: true
}))

// Test route options
app.get('/sse', { sse: true }, async (request, reply) => {
  expectType<SSEReplyInterface>(reply.sse)
  return reply.sse.send({ data: 'test' })
})

app.get('/sse-with-options', {
  sse: {
    heartbeat: true,
    serializer: (data: any) => JSON.stringify(data)
  }
}, async (request, reply) => {
  expectType<SSEReplyInterface>(reply.sse)
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

expectType<string | undefined>(message.id)
expectType<string | undefined>(message.event)
expectType<any>(message.data)
expectType<number | undefined>(message.retry)

// Test SSE sources
const stringSource: SSESource = 'hello'
const bufferSource: SSESource = Buffer.from('hello')
const messageSource: SSESource = { data: 'test' }
const streamSource: SSESource = new Readable()

async function* asyncGenerator(): AsyncIterable<SSEMessage> {
  yield { data: 'test' }
}
const asyncIterableSource: SSESource = asyncGenerator()

// Test SSE reply interface
app.get('/test-reply', { sse: true }, async (request, reply) => {
  // Test properties
  expectType<string | null>(reply.sse.lastEventId)
  expectType<boolean>(reply.sse.isConnected)

  // Test send method with different sources
  expectType<Promise<void>>(reply.sse.send('string'))
  expectType<Promise<void>>(reply.sse.send(Buffer.from('buffer')))
  expectType<Promise<void>>(reply.sse.send({ data: 'object' }))
  expectType<Promise<void>>(reply.sse.send(new Readable()))
  expectType<Promise<void>>(reply.sse.send(asyncGenerator()))

  // Test stream method
  expectType<NodeJS.WritableStream>(reply.sse.stream())

  // Test keepAlive method
  expectType<void>(reply.sse.keepAlive())

  // Test close method
  expectType<void>(reply.sse.close())

  // Test replay method
  expectType<Promise<void>>(reply.sse.replay(async (lastEventId: string) => {
    console.log(lastEventId)
  }))

  // Test onClose method
  expectType<void>(reply.sse.onClose(() => {
    console.log('closed')
  }))
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

expectAssignable<SSESource>(complexMessage)

// Test async iterator types
async function* typedAsyncGenerator(): AsyncIterable<string> {
  yield 'test'
}

async function* mixedAsyncGenerator(): AsyncIterable<SSEMessage | string | Buffer> {
  yield { data: 'message' }
  yield 'string'
  yield Buffer.from('buffer')
}

expectAssignable<SSESource>(typedAsyncGenerator())
expectAssignable<SSESource>(mixedAsyncGenerator())

// Test plugin options interface
const pluginOptions: SSEPluginOptions = {
  heartbeatInterval: 15000,
  serializer: (data) => {
    expectType<any>(data)
    return JSON.stringify(data)
  }
}

// Test serializer function type
const customSerializer = (data: any): string => {
  if (typeof data === 'object') {
    return JSON.stringify(data)
  }
  return String(data)
}

expectAssignable<SSEPluginOptions>({
  serializer: customSerializer
})

// Test route options with boolean
const routeOptions1: RouteShorthandOptions = {
  sse: true
}

const routeOptions2: RouteShorthandOptions = {
  sse: false
}

const routeOptions3: RouteShorthandOptions = {
  sse: {
    heartbeat: false,
    serializer: (data) => String(data)
  }
}

// Test invalid route options - these tests verify type checking
expectError(app.get('/invalid', {
  sse: 'invalid'
}, async (request, reply) => {}))

expectError(app.get('/invalid2', {
  sse: {
    unknownOption: true
  }
}, async (request, reply) => {}))