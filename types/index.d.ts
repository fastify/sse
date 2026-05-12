import { FastifyPluginAsync } from 'fastify'
import { Readable } from 'stream'

declare module 'fastify' {
  interface FastifyReply {
    sse: SSEReplyInterface
  }

  interface RouteShorthandOptions {
    sse?: SSERouteOptions
  }
}

/**
 * Declares how a route handles the SSE/non-SSE split.
 *
 * - `'only'` — SSE-only. Lenient gate: any spec-compliant Accept admits
 *   SSE. Clients that explicitly refuse SSE receive 406 Not Acceptable.
 * - `'dual'` — Route serves both SSE and non-SSE on the same handler.
 *   Strict gate: only an explicit `text/event-stream` token admits SSE;
 *   the handler must branch on `reply.sse` to serve other clients.
 */
export type SSERouteKind = 'only' | 'dual'

/**
 * Per-route SSE options.
 *
 * Accepted values:
 * - `true` — Back-compat. Routes like `'dual'` for gate behavior; on the
 *   fallback path the plugin rethrows with a message naming `'only'` as
 *   the fix if the handler tries to use `reply.sse`.
 * - `'only'` / `'dual'` — Shorthand for the matching kind.
 * - Object form — Same kinds via `kind`, plus per-route option overrides.
 *   `kind` omitted = back-compat behavior, equivalent to `sse: true`.
 */
export type SSERouteOptions = boolean | SSERouteKind | {
  kind?: SSERouteKind
  heartbeat?: boolean
  serializer?: (data: any) => string
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

export default fastifySSE
