/**
 * Email queue + worker — enqueue emails via BullMQ with SMTP fallback.
 */
import { createLogger, markLogged } from '../infra/logger';
import { createQueue, createWorker } from '../infra/queue';
import { getEmailDeps } from './deps';
import { renderTemplate } from './template';
import {
  type SendEmailOptions,
  isAnonymizedAddress,
  isPermanentEmailError,
  isValidEmail,
  sendEmail,
} from './transport';
import { UnrecoverableError } from 'bullmq';

const logger = createLogger('Email');

// ---------------------------------------------------------------------------
// Job payloads
// ---------------------------------------------------------------------------

/** Per-message delivery options carried through the queue. */
export type EnqueueEmailOptions = Pick<SendEmailOptions, 'replyTo' | 'headers'>;

interface EmailJob extends EnqueueEmailOptions {
  to: string;
  template: string;
  data: Record<string, string>;
  locale: string;
}

interface RawEmailJob extends EnqueueEmailOptions {
  to: string;
  subject: string;
  html: string;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const emailQueue = createQueue('email');

const DEFAULT_RETRY = {
  attempts: 6,
  backoff: { type: 'exponential' as const, delay: 5 * 60_000 },
};

function getRetryPolicy() {
  try {
    return getEmailDeps().retryPolicy ?? DEFAULT_RETRY;
  } catch {
    return DEFAULT_RETRY;
  }
}

/**
 * Drop malformed and GDPR-anonymized addresses before they enter the queue —
 * a bad address would otherwise burn every retry attempt over hours.
 */
function filterRecipients(
  recipients: string[],
  context: Record<string, unknown>
): string[] {
  const anonymized = recipients.filter(isAnonymizedAddress);
  if (anonymized.length > 0) {
    logger.warn('Refusing to email GDPR-deleted recipient(s)', {
      ...context,
      count: anonymized.length,
    });
  }
  return recipients.filter((e) => isValidEmail(e) && !isAnonymizedAddress(e));
}

/**
 * Enqueue a templated email.
 * Validates recipients, carries locale through the queue for template resolution.
 */
export async function enqueueTemplateEmail(
  to: string | string[],
  template: string,
  vars: Record<string, string>,
  locale = 'en',
  opts: EnqueueEmailOptions = {}
): Promise<void> {
  const recipients = Array.isArray(to) ? to : [to];
  const valid = filterRecipients(recipients, { template });

  if (valid.length === 0) {
    logger.warn('No valid recipients, skipping enqueue', {
      template,
      to: recipients,
    });
    return;
  }

  if (emailQueue) {
    await emailQueue.add(
      'send-template',
      {
        to: valid.join(','),
        template,
        data: vars,
        locale,
        replyTo: opts.replyTo,
        headers: opts.headers,
      } satisfies EmailJob,
      getRetryPolicy()
    );
  } else {
    // No Redis — render and send synchronously in dev
    logger.info(
      `Sending directly (no Redis): ${template} -> ${valid.join(', ')}`
    );
    const deps = getEmailDeps();
    const branding = await deps.getBranding();
    const extraLayoutVars =
      typeof deps.extraLayoutVars === 'function'
        ? deps.extraLayoutVars()
        : deps.extraLayoutVars;
    const { subject, html } = await renderTemplate(
      template,
      vars,
      locale,
      branding,
      {
        templatesDir: deps.templatesDir,
        getTemplateOverride: deps.getTemplateOverride,
        extraLayoutVars,
      }
    );
    await sendEmail(valid, subject, html, opts);
  }
}

/**
 * Enqueue a raw HTML email (e.g. form submission notifications).
 * No template rendering — HTML is pre-built by the caller.
 */
export async function enqueueEmail(
  payload: {
    to: string;
    subject: string;
    html: string;
  } & EnqueueEmailOptions
): Promise<void> {
  const [valid] = filterRecipients([payload.to], { subject: payload.subject });
  if (!valid) {
    logger.warn('Invalid recipient, skipping enqueue', { to: payload.to });
    return;
  }

  if (emailQueue) {
    await emailQueue.add(
      'send-raw',
      payload satisfies RawEmailJob,
      getRetryPolicy()
    );
  } else {
    logger.info(
      `Sending directly (no Redis): ${payload.subject} -> ${payload.to}`
    );
    await sendEmail(payload.to, payload.subject, payload.html, {
      replyTo: payload.replyTo,
      headers: payload.headers,
    });
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * Initialize email worker with rate limiting.
 * Defaults: concurrency 5, rate 5/min (300/hour SMTP limit).
 * Override via `setEmailDeps({ concurrency, rateLimiter })`.
 */
export function startEmailWorker(): void {
  let deps: ReturnType<typeof getEmailDeps> | null = null;
  try {
    deps = getEmailDeps();
  } catch {
    /* deps not set yet — use defaults */
  }

  const concurrency = deps?.concurrency ?? 5;
  const limiter = deps?.rateLimiter ?? { max: 5, duration: 60_000 };

  const worker = createWorker(
    'email',
    async (job) => {
      try {
        if (job.name === 'send-raw') {
          const raw = job.data as RawEmailJob;
          await sendEmail(raw.to, raw.subject, raw.html, {
            replyTo: raw.replyTo,
            headers: raw.headers,
          });
          logger.info('Raw email sent', { to: raw.to, subject: raw.subject });
          return;
        }

        // Template email
        const { to, template, data, locale, replyTo, headers } =
          job.data as EmailJob;
        const d = getEmailDeps();
        const branding = await d.getBranding();
        const extraVars =
          typeof d.extraLayoutVars === 'function'
            ? d.extraLayoutVars()
            : d.extraLayoutVars;
        const { subject, html } = await renderTemplate(
          template,
          data,
          locale,
          branding,
          {
            templatesDir: d.templatesDir,
            getTemplateOverride: d.getTemplateOverride,
            extraLayoutVars: extraVars,
          }
        );

        const recipients = to.includes(',')
          ? to.split(',').map((e) => e.trim())
          : to;
        await sendEmail(recipients, subject, html, { replyTo, headers });

        logger.info('Email sent', {
          template,
          recipientCount: Array.isArray(recipients) ? recipients.length : 1,
        });
      } catch (err) {
        if (isPermanentEmailError(err)) {
          // No provider and no retry will help — fail the job now rather than
          // after the full retry envelope. Logged here with job context, so the
          // generic `failed` listener keeps quiet (markLogged).
          logger.error('Email permanently failed', {
            jobId: job.id,
            jobName: job.name,
            error: err instanceof Error ? err.message : String(err),
          });
          throw markLogged(
            new UnrecoverableError(
              err instanceof Error ? err.message : String(err)
            )
          );
        }
        throw err;
      }
    },
    concurrency,
    { limiter }
  );

  if (worker) {
    logger.info(
      `Email worker started (concurrency: ${concurrency}, rate: ${limiter.max}/${limiter.duration}ms)`
    );
  }
}
