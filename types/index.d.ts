import { FastifyPluginAsync } from 'fastify'
import { Readable } from 'stream'

declare module 'fastify' {
  interface FastifyReply {
    sse: SSEReplyInterface
  }

  interface RouteShorthandOptions {
    sse?: boolean | {
      heartbeat?: boolean
      serializer?: (data: any) => string
      /**
       * Require an explicit `text/event-stream` token in the Accept header
       * for this route. Overrides the plugin-level `strictAccept` setting.
       * @default false
       */
      strictAccept?: boolean
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

  /**
   * Require an explicit `text/event-stream` token in the Accept header to
   * serve SSE. When false (default), the plugin follows RFC 9110 §12.5.1 and
   * admits SSE for `*\/*`, `text/*`, and missing Accept headers. When true,
   * those ambiguous headers fall through to the regular handler.
   * @default false
   */
  strictAccept?: boolean
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

  /**
   * Check if the connection should be kept alive after handler completion
   */
  readonly shouldKeepAlive: boolean

  /**
   * Send HTTP headers for the SSE response if not already sent.
   * This method ensures headers set via reply.header() are transferred
   * to the raw response before calling writeHead(200).
   * Called automatically before the first SSE data is sent, but can
   * also be called manually if needed.
   */
  sendHeaders(): void
}

export declare const fastifySSE: FastifyPluginAsync<SSEPluginOptions>

/**
 * Determine whether the client's Accept header admits `text/event-stream`,
 * implementing the RFC 9110 §12.5.1 precedence model for the media ranges
 * relevant to SSE (`text/event-stream`, `text/*`, `*\/*`).
 *
 * Default (lenient) returns true when the header is missing, empty, or
 * admits SSE via a matching range with quality > 0. The most specific
 * matching range wins, so `*\/*, text/event-stream;q=0` returns false.
 *
 * Pass `{ strict: true }` to require an explicit `text/event-stream` token
 * with quality > 0; ambiguous headers (`*\/*`, `text/*`, missing) return
 * false in strict mode.
 */
export declare function clientAcceptsSSE (
  acceptHeader: string | undefined,
  options?: { strict?: boolean }
): boolean

export default fastifySSE
