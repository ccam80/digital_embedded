/**
 * Tutorial host page logic
 * Manages markdown loading, iframe setup, and checkpoint navigation
 */

import { renderMarkdown } from './markdown-renderer.js';

/**
 * Parsed URL parameters for tutorial host
 */
export interface TutorialParams {
  tutorial: string;
  step: number;
}

/**
 * Configuration for a checkpoint
 */
export interface CheckpointConfig {
  tutorial: string;
  step: number;
  basePath: string;
  instructionsUrl: string;
}

/**
 * Parse and validate URL parameters
 *
 * @param searchParams - URL search params string (e.g., "tutorial=intro-to-logic&step=2")
 * @returns Parsed parameters with defaults
 */
export function parseUrlParams(
  searchParams: URLSearchParams
): Partial<TutorialParams> {
  const tutorial = searchParams.get('tutorial');
  const stepStr = searchParams.get('step');

  const params: Partial<TutorialParams> = {};

  if (tutorial) {
    params.tutorial = tutorial;
  }

  if (stepStr) {
    const step = parseInt(stepStr, 10);
    if (!isNaN(step) && step > 0) {
      params.step = step;
    }
  }

  return params;
}

/**
 * Build the checkpoint path for a given tutorial and step
 *
 * @param tutorial - Tutorial name (e.g., "intro-to-logic")
 * @param step - Step number (1-indexed)
 * @returns Path like "tutorials/intro-to-logic/checkpoint-2/"
 */
export function buildCheckpointPath(tutorial: string, step: number): string {
  return `tutorials/${tutorial}/checkpoint-${step}/`;
}

/**
 * Build the instructions URL for a checkpoint
 *
 * @param basePath - Base path for the checkpoint
 * @returns URL like "tutorials/intro-to-logic/checkpoint-2/instructions.md"
 */
export function buildInstructionsUrl(basePath: string): string {
  return `${basePath}instructions.md`;
}

/**
 * Build simulator iframe src with proper parameters
 *
 * @param simulatorUrl - URL to the simulator entry (defaults to deploy root '/')
 * @param basePath - Base path for circuit file resolution
 * @param file - Optional circuit file to load (e.g., "and-gate.dig")
 * @returns Complete iframe src URL
 */
export function buildIframeSrc(
  simulatorUrl: string,
  basePath: string,
  file?: string
): string {
  const params = new URLSearchParams();
  params.set('base', basePath);
  if (file) {
    params.set('file', file);
  }
  return `${simulatorUrl}?${params.toString()}`;
}

/**
 * Tutorial host manager
 * Handles loading instructions and managing iframe interactions
 */
export class TutorialHost {
  private contentContainer: HTMLElement | null;
  private iframes: HTMLIFrameElement[] = [];

  constructor(contentContainerId: string) {
    this.contentContainer = document.getElementById(contentContainerId);
  }

  /**
   * Initialize the tutorial host with parameters
   *
   * @param tutorial - Tutorial name
   * @param step - Step number (1-indexed)
   * @param simulatorUrl - URL to the simulator entry (defaults to deploy root '/')
   */
  async init(
    tutorial: string,
    step: number,
    simulatorUrl: string = '/'
  ): Promise<void> {
    const basePath = buildCheckpointPath(tutorial, step);
    const instructionsUrl = buildInstructionsUrl(basePath);

    // checkpoint data captured locally (not stored)
    void { tutorial, step, basePath, instructionsUrl };

    // Load and render instructions
    await this.loadInstructions(instructionsUrl);

    // Update all iframes with new base path
    this.updateIframeBasePaths(basePath, simulatorUrl);
  }

  /**
   * Load markdown instructions and render to HTML
   *
   * @param url - URL to instructions.md
   */
  private async loadInstructions(url: string): Promise<void> {
    if (!this.contentContainer) {
      throw new Error('Content container not found');
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to load instructions: ${response.statusText}`);
      }
      const markdown = await response.text();
      const html = renderMarkdown(markdown);
      this.contentContainer.innerHTML = html;
    } catch (error) {
      this.contentContainer.innerHTML = `<p style="color: red;">Error loading instructions: ${error instanceof Error ? error.message : String(error)}</p>`;
    }
  }

  /**
   * Register an iframe to be managed by this host
   *
   * @param iframe - The iframe element
   */
  registerIframe(iframe: HTMLIFrameElement): void {
    this.iframes.push(iframe);
  }

  /**
   * Update all registered iframes with new base path
   *
   * @param basePath - New base path for circuit resolution
   * @param simulatorUrl - URL to the simulator entry (defaults to deploy root '/')
   */
  private updateIframeBasePaths(
    basePath: string,
    simulatorUrl: string
  ): void {
    for (const iframe of this.iframes) {
      // Send postMessage to each iframe to update base path
      const message = {
        type: 'sim-set-base',
        basePath: basePath,
      };
      iframe.contentWindow?.postMessage(message, '*');

      // Also update the iframe src to include the base parameter
      // This ensures proper base path for initial load
      const src = iframe.src || buildIframeSrc(simulatorUrl, basePath);
      const url = new URL(src, window.location.href);
      url.searchParams.set('base', basePath);
      iframe.src = url.toString();
    }
  }

  /**
   * Navigate to a different checkpoint
   *
   * @param tutorial - Tutorial name
   * @param step - Step number (1-indexed)
   * @param simulatorUrl - URL to the simulator entry (defaults to deploy root '/')
   */
  async navigateToCheckpoint(
    tutorial: string,
    step: number,
    simulatorUrl: string = '/'
  ): Promise<void> {
    await this.init(tutorial, step, simulatorUrl);
  }
}

/**
 * Set up checkpoint navigation buttons/links
 *
 * @param tutorial - Current tutorial name
 * @param steps - Number of steps in the tutorial
 * @param onNavigate - Callback when a checkpoint is selected
 * @param buttonContainerId - ID of the container for navigation buttons
 */
export function setupCheckpointNavigation(
  tutorial: string,
  steps: number,
  onNavigate: (tutorial: string, step: number) => Promise<void>,
  buttonContainerId: string
): void {
  const container = document.getElementById(buttonContainerId);
  if (!container) {
    return;
  }

  container.innerHTML = '';

  for (let i = 1; i <= steps; i++) {
    const button = document.createElement('button');
    button.textContent = `Checkpoint ${i}`;
    button.className = 'checkpoint-nav-button';
    button.onclick = async () => {
      await onNavigate(tutorial, i);
    };
    container.appendChild(button);
  }
}
