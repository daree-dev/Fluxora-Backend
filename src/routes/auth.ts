import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { generateToken } from '../lib/auth.js';
import { validationError, asyncHandler } from '../middleware/errorHandler.js';
import { info } from '../utils/logger.js';
import { recordAuditEvent } from '../lib/auditLog.js';

export const authRouter = Router();

// Schema for session creation
const SessionRequestSchema = z.object({
  address: z.string().min(1, 'Stellar address is required'),
  role: z.enum(['operator', 'viewer']).optional().default('viewer'),
});

/**
 * POST /api/auth/session
 *
 * Issues a JWT for a dashboard client.
 * In this iteration, any valid Stellar address can obtain a session.
 */
authRouter.post(
  '/session',
  asyncHandler(async (req: Request, res: Response) => {
    const correlationId = req.correlationId;
    const result = SessionRequestSchema.safeParse(req.body);

    if (!result.success) {
      // Explicit audit for failed auth attempts
      recordAuditEvent(
        'AUTH_FAILED',
        'session',
        '',
        correlationId,
        { reason: 'validation_error', errors: result.error.format() },
        { actor: 'anonymous', actorRole: 'anonymous', httpMethod: 'POST', httpPath: '/api/auth/session', httpStatus: 400, outcome: 'failure' },
      );
      throw validationError('Invalid session request', result.error.format());
    }

    const { address, role } = result.data;
    const token = generateToken({ address, role: role as 'operator' | 'viewer' });

    info('Session created', { address, role, correlationId });

    // Explicit audit for successful session creation
    recordAuditEvent(
      'SESSION_CREATED',
      'session',
      address,
      correlationId,
      { role },
      { actor: address, actorRole: role, httpMethod: 'POST', httpPath: '/api/auth/session', httpStatus: 200, outcome: 'success' },
    );

    res.json({
      token,
      user: { address, role },
    });
  }),
);
