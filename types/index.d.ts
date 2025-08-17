import { Readable } from 'stream'

declare module 'fastify' {
  interface FastifyReply {
    sse: SSEReplyInterface
  }

  interface RouteOptions {
    sse?: boolean | {
      heartbeat?: boolean
      serializer?: (data: any) => string
    }
  }
}

export interface SSEPluginOptions {
  /**
   * Interval in milliseconds for sending heartbeat comments
   * Set to 0 to disable heartbeats
   * @default 30000
   */
  heartbeatInterval?: number

  /**
   * Default serializer for data payloads
   * @default JSON.stringify
   */
  serializer?: (data: any) => string
}

export interface SSEMessage {
  /**
   * Event ID for client-side tracking
   */
  id?: string

  /**
   * Event type name
   */
  event?: string

  /**
   * Event data payload
   */
  data: any

  /**
   * Retry interval in milliseconds
   */
  retry?: number
}

export type SSESource = 
  | SSEMessage 
  | string 
  | Buffer 
  | Readable
  | AsyncIterable<SSEMessage | string | Buffer>

export interface SSEReplyInterface {
  /**
   * Last Event ID sent by the client
   */
  readonly lastEventId: string | null

  /**
   * Send an SSE event or stream
   */
  send(source: SSESource): Promise<void>

  /**
   * Create a transform stream for pipeline operations
   */
  stream(): NodeJS.WritableStream

  /**
   * Keep the connection alive (prevent handler from closing it)
   */
  keepAlive(): void

  /**
   * Close the SSE connection
   */
  close(): void

  /**
   * Handle replay of events based on Last-Event-ID
   */
  replay(callback: (lastEventId: string) => Promise<void>): Promise<void>

  /**
   * Register a callback for when the connection closes
   */
  onClose(callback: () => void): void

  /**
   * Check if the connection is still active
   */
  readonly isConnected: boolean
}

declare const fastifySSE: FastifyPluginAsync<SSEPluginOptions>

export default fastifySSE