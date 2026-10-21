import { ServiceUnavailableException } from '@nestjs/common';

export const QUEUE_UNAVAILABLE = 'QUEUE_UNAVAILABLE';

/** The cause (a Redis error) can carry host names, so only the fixed code is returned. */
export const queueUnavailable = (): ServiceUnavailableException =>
  new ServiceUnavailableException({
    message: 'The processing queue is unavailable, try again',
    code: QUEUE_UNAVAILABLE,
  });
