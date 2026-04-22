import { Router, Request, Response } from 'express';
import { formatFromStroops } from '../serialization/decimal.js';
import {
  ApiError,
  ApiErrorCode,
  notFound,
  validationError,
  conflictError,
  asyncHandler,
} from '../middleware/errorHandler.js';
import { authenticate, requireAuth } from '../middleware/auth.js';
import { info, debug, error } from '../utils/logger.js';
import { verifyStreamOnChain } from '../lib/stellar.js';
import { getConfig } from '../config/env.js';
import { recordAuditEvent } from '../lib/auditLog.js';

/**
 * Streams API routes (BigInt-Safe Implementation)
 */
export const streamsRouter = Router();

/**
 * Internal Stream type using BigInt for stroops
 */
export interface Stream {
  id: string;
  sender: string;
  recipient: string;
  depositAmount: bigint;
  ratePerSecond: bigint;
  startTime: number;
  endTime: number;
  status: string;
}

// In-memory stream store
export const streams: Stream[] = [];

// Idempotency store
const idempotencyStore = new Map<string, {
  fingerprint: string;
  statusCode: number;
  body: unknown;
}>();

function parseIdempotencyKey(headerValue: unknown): string {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw validationError('Idempotency-Key header is required');
  }
  return headerValue.trim();
}

/**
 * GET /api/streams
 * List all streams, formatting BigInt to string
 */
streamsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    info('Listing all streams', { count: streams.length });

    const serializedStreams = streams.map(s => ({
      ...s,
      depositAmount: formatFromStroops(s.depositAmount),
      ratePerSecond: formatFromStroops(s.ratePerSecond),
    }));

    res.json({
      streams: serializedStreams,
      total: streams.length,
    });
  }),
);

/**
 * GET /api/streams/:id
 * Get a single stream, formatting BigInt to string
 */
streamsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    debug('Fetching stream', { id });

    const stream = streams.find((s) => s.id === id);
    if (!stream) {
      throw notFound('Stream', id);
    }

    res.json({
      ...stream,
      depositAmount: formatFromStroops(stream.depositAmount),
      ratePerSecond: formatFromStroops(stream.ratePerSecond),
    });
  }),
);

/**
 * POST /api/streams
 * Create a new stream via on-chain verification
 */
streamsRouter.post(
  '/',
  authenticate,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { transactionHash } = req.body ?? {};
    const correlationId = req.correlationId;
    const actor = req.user?.address ?? 'anonymous';
    const actorRole = req.user?.role ?? 'anonymous';
    const idempotencyKey = parseIdempotencyKey(req.header('Idempotency-Key'));

    if (!transactionHash) {
      throw validationError('transactionHash is required');
    }

    // Check idempotency
    const fingerprint = JSON.stringify({ transactionHash });
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw conflictError('Idempotency key reused with different payload');
      }
      res.set('Idempotency-Replayed', 'true');
      res.status(cached.statusCode).json(cached.body);
      return;
    }

    info('Verifying on-chain stream', { transactionHash, correlationId });

    // Trust boundary: Verify the transaction on Stellar
    const verified = await verifyStreamOnChain(transactionHash);

    const id = `stream-${transactionHash.slice(0, 8)}`;

    // Handle duplicate stream ID (idempotent re-creation)
    const existingStream = streams.find(s => s.id === id);
    if (existingStream) {
      const responseBody = {
        ...existingStream,
        depositAmount: formatFromStroops(existingStream.depositAmount),
        ratePerSecond: formatFromStroops(existingStream.ratePerSecond),
      };
      idempotencyStore.set(idempotencyKey, { fingerprint, statusCode: 200, body: responseBody });
      res.status(200).json(responseBody);
      return;
    }

    const stream: Stream = { id, ...verified, status: 'active' };
    streams.push(stream);

    const responseBody = {
      ...stream,
      depositAmount: formatFromStroops(stream.depositAmount),
      ratePerSecond: formatFromStroops(stream.ratePerSecond),
    };

    idempotencyStore.set(idempotencyKey, { fingerprint, statusCode: 201, body: responseBody });

    info('Stream verified and indexed', { id, transactionHash, correlationId });

    // Explicit audit: richer context than the middleware can infer
    recordAuditEvent('STREAM_CREATED', 'stream', id, correlationId, {
      transactionHash,
      sender: verified.sender,
      recipient: verified.recipient,
      depositAmount: formatFromStroops(verified.depositAmount),
      ratePerSecond: formatFromStroops(verified.ratePerSecond),
    }, { actor, actorRole, httpMethod: 'POST', httpPath: '/api/streams', httpStatus: 201, outcome: 'success' });

    res.status(201).json(responseBody);
  }),
);

/**
 * DELETE /api/streams/:id
 * Cancel a stream
 */
streamsRouter.delete(
  '/:id',
  authenticate,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const correlationId = req.correlationId;
    const actor = req.user?.address ?? 'anonymous';
    const actorRole = req.user?.role ?? 'anonymous';

    debug('Cancelling stream', { id, correlationId });

    const index = streams.findIndex((s) => s.id === id);
    const stream = streams[index];

    if (index === -1 || !stream) {
      throw notFound('Stream', id);
    }

    if (stream.status === 'cancelled') {
      throw new ApiError(ApiErrorCode.CONFLICT, 'Stream is already cancelled', 409, { streamId: id });
    }
    if (stream.status === 'completed') {
      throw new ApiError(ApiErrorCode.CONFLICT, 'Cannot cancel a completed stream', 409, { streamId: id });
    }

    streams[index] = { ...stream, status: 'cancelled' };

    info('Stream cancelled', { id, correlationId });

    // Explicit audit for cancellation
    recordAuditEvent('STREAM_CANCELLED', 'stream', id, correlationId, {
      previousStatus: stream.status,
    }, { actor, actorRole, httpMethod: 'DELETE', httpPath: `/api/streams/${id}`, httpStatus: 200, outcome: 'success' });

    res.json({ message: 'Stream cancelled', id });

    // Fire-and-forget webhook dispatch
    try {
      const config = getConfig();
      if (config.webhookUrl && config.webhookSecret) {
        const { dispatchWebhook } = await import('../lib/webhooks.js');
        dispatchWebhook({
          url: config.webhookUrl,
          secret: config.webhookSecret,
          event: 'stream.deleted',
          payload: streams[index],
        }).catch((err: Error) => error('Failed to dispatch deletion webhook', { streamId: id }, err));
      }
    } catch {
      // Webhook dispatch is best-effort; never block the response
    }
  }),
);
