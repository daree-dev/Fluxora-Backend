import { Router } from 'express';

import { ApiError } from '../errors.js';

export const streamsRouter = Router();

// Placeholder: replace with DB and contract sync later
const streams: Array<{
  id: string;
  sender: string;
  recipient: string;
  depositAmount: string;
  ratePerSecond: string;
  startTime: number;
  status: string;
}> = [];

streamsRouter.get('/', (_req, res) => {
  res.json({ streams });
});

streamsRouter.get('/:id', (req, res) => {
  const stream = streams.find((s) => s.id === req.params.id);
  if (!stream) {
    throw new ApiError(404, 'stream_not_found', 'Stream not found', {
      streamId: req.params.id,
    });
  }

  res.json(stream);
});

streamsRouter.post('/', (req, res) => {
  const { sender, recipient, depositAmount, ratePerSecond, startTime } = req.body ?? {};

  if (typeof sender !== 'string' || sender.trim() === '') {
    throw new ApiError(400, 'validation_error', '`sender` is required', {
      field: 'sender',
    });
  }

  if (typeof recipient !== 'string' || recipient.trim() === '') {
    throw new ApiError(400, 'validation_error', '`recipient` is required', {
      field: 'recipient',
    });
  }

  if (typeof depositAmount !== 'string' || depositAmount.trim() === '') {
    throw new ApiError(400, 'validation_error', '`depositAmount` is required', {
      field: 'depositAmount',
    });
  }

  if (typeof ratePerSecond !== 'string' || ratePerSecond.trim() === '') {
    throw new ApiError(400, 'validation_error', '`ratePerSecond` is required', {
      field: 'ratePerSecond',
    });
  }

  if (!Number.isInteger(startTime) || startTime <= 0) {
    throw new ApiError(400, 'validation_error', '`startTime` must be a positive unix timestamp', {
      field: 'startTime',
    });
  }

  const id = `stream-${Date.now()}`;
  const stream = {
    id,
    sender,
    recipient,
    depositAmount,
    ratePerSecond,
    startTime,
    status: 'active',
  };
  streams.push(stream);
  res.status(201).json(stream);
});
