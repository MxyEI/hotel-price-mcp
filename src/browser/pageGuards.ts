import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { env } from '../config/env.js';

export async function saveFailureArtifact(provider: string, page: Page, reason: string): Promise<string | undefined> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directory = path.join(env.ARTIFACT_DIR, provider);
    await mkdir(directory, { recursive: true });

    const safeReason = reason.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    const screenshotPath = path.join(directory, `${timestamp}-${safeReason || 'failure'}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch {
    return undefined;
  }
}

export async function detectPageBlock(page: Page): Promise<'captcha' | 'blocked' | undefined> {
  const title = await page.title().catch(() => '');
  const body = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  const combined = `${title}\n${body}`.toLowerCase();

  if (/captcha|验证码|安全验证|人机验证|robot|verify you are human/.test(combined)) {
    return 'captcha';
  }

  if (/access denied|forbidden|blocked|拒绝访问|访问受限/.test(combined)) {
    return 'blocked';
  }

  return undefined;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
