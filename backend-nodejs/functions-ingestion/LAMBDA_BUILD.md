# Lambda Build & Bundling Guide

## Why esbuild Bundling?

The `dist-lambda/` directory contains **esbuild-bundled output** (not source code). This is intentional for AWS Lambda optimization:

### Benefits
1. **Size Optimization**: AWS Lambda has a 50MB uncompressed limit per function
   - Single file bundling removes redundant dependencies
   - Minification reduces code size by ~40-50%
   - Tree-shaking eliminates unused exports

2. **Startup Performance**: Fewer file I/O operations at cold start
   - Single monolithic file vs. thousands of npm modules
   - Faster module resolution during Lambda initialization

3. **Deployment Simplicity**: Single ZIP file upload instead of node_modules

### Build Process

```bash
# Source files
src/lambda-http.ts    → Entry point wrapping Express via serverless-http
src/lambda-worker.ts  → Entry point wrapping SQS message processor

# Build command
npm run build:lambda  → Uses esbuild to bundle + minify

# Output
dist-lambda/
├── http/index.js     → ~5000+ lines (bundled: Express + dependencies)
└── worker/index.js   → ~5000+ lines (bundled: AWS SDK + dependencies)

# Package for Lambda
dist-lambda/http.zip  → ~1.2MB (after compression)
dist-lambda/worker.zip → ~0.8MB (after compression)
```

## Understanding the Bundled Output

### What's in the Bundle?

```javascript
// After esbuild bundling, you see:
var __create = Object.create;
var __defProp = Object.defineProperty;
// ... (esbuild runtime helpers for ESM→CJS conversion)

// All dependencies are inlined:
// - @aws-sdk/* clients
// - express + middleware
// - openai + other packages
// - app.ts + all handlers

export const handler = ... // Final Lambda handler
```

This is **completely normal and expected**. The minified format is intended to reduce file size and improve performance.

## Debugging Bundled Code

If you need to debug issues in the bundled code:

### Option 1: Generate Source Maps (Recommended)
```bash
# Modify package.json scripts:
"build:lambda:http": "npx esbuild src/lambda-http.ts --bundle --platform=node --target=node20 --sourcemap --outfile=dist-lambda/http/index.js",
"build:lambda:worker": "npx esbuild src/lambda-worker.ts --bundle --platform=node --target=node20 --sourcemap --outfile=dist-lambda/worker/index.js"

# This generates .map files for IDE debugging
```

### Option 2: Check Source Code Instead
If there's a bug, check the **source files**:
- `src/lambda-http.ts` (8 lines) - Simple wrapper
- `src/lambda-worker.ts` (20 lines) - Simple wrapper  
- `src/server-aws.ts` (600+ lines) - Actual business logic
- `src/shared/*.ts` (all handlers)

The bundled output is just the compiled version of these files.

### Option 3: Add CloudWatch Logging
```typescript
// In src/server-aws.ts or handlers
console.log("DEBUG:", {
  allowedTenants: process.env.ALLOWED_TENANT_IDS,
  incomingTenant: tenantId,
  isAllowed: isTenantAllowed(tenantId)
});
```

These logs appear in AWS CloudWatch Logs for the Lambda function.

## Rebuilding After Source Changes

```bash
# After modifying src/*.ts files:
npm run build:lambda

# Then deploy via GitHub Actions
git add src/
git commit -m "Update Lambda logic"
git push  # Triggers deploy-node-aws.yml

# Or manually:
npm run build:lambda
# Upload dist-lambda/*.zip to AWS Lambda via console
```

## TL;DR

- **dist-lambda/ files are minified, bundled output** → This is normal
- **Source truth is src/ files** → Modify these, not the dist output
- **GitHub Actions handles building + deploying** → No manual ZIP creation needed
- **For debugging, check source files or CloudWatch logs** → Not the minified code
