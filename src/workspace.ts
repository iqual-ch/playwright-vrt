#!/usr/bin/env bun

import * as fs from 'fs';
import * as path from 'path';

/**
 * Workspace manages the .playwright-vrt/ directory
 * This is persistent between runs for debugging and caching
 */
export class Workspace {
  private readonly dir: string;

  constructor(baseDir?: string) {
    // Use .playwright-vrt in current directory (or specified base)
    this.dir = path.join(baseDir || process.cwd(), '.playwright-vrt');

    // Create workspace directory
    fs.mkdirSync(this.dir, { recursive: true });
  }

  getPath(file: string = ''): string {
    return file ? path.join(this.dir, file) : this.dir;
  }

  writeFile(filename: string, content: string): void {
    const filePath = this.getPath(filename);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf-8');
  }

  readFile(filename: string): string {
    const filePath = this.getPath(filename);
    return fs.readFileSync(filePath, 'utf-8');
  }

  exists(filename: string): boolean {
    return fs.existsSync(this.getPath(filename));
  }

  writeJSON(filename: string, data: any): void {
    this.writeFile(filename, JSON.stringify(data, null, 2));
  }

  readJSON(filename: string): any {
    return JSON.parse(this.readFile(filename));
  }

  // Manual cleanup - workspace is persistent by default
  clean(): void {
    if (fs.existsSync(this.dir)) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      console.log(`🗑️  Cleaned workspace: ${this.dir}`);
    }
  }

  info(): void {
    console.log(`📁 Workspace: ${this.dir}`);
  }
}
