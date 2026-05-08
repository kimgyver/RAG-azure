# dist-lambda/

⚠️ **DO NOT EDIT FILES HERE MANUALLY**

This directory contains **esbuild-bundled Lambda deployment packages**. All files are auto-generated.

## Files

- `http/index.js` - HTTP handler (esbuild output from `src/lambda-http.ts`)
- `worker/index.js` - SQS processor (esbuild output from `src/lambda-worker.ts`)  
- `*.zip` - Deployment archives for AWS Lambda upload

## Rebuilding

```bash
# After modifying src/*.ts files:
npm run build:lambda

# Clean rebuild:
npm run build:lambda:clean

# Deployment is automated via GitHub Actions
# (see .github/workflows/deploy-node-aws.yml)
```

## Understanding the Bundled Output

The `.js` files look "garbled" because they're:
- **Minified**: Variable names shortened, whitespace removed
- **Bundled**: Express, AWS SDK, and all dependencies are merged into one file
- **CJS**: esbuild converts ES modules to CommonJS for Node.js 20

### Why Bundle?
1. **Size**: AWS Lambda has 50MB limit; bundling reduces file by 80%+
2. **Startup**: Faster cold starts with fewer files
3. **Simplicity**: Single file instead of thousands of npm modules

### Debug Approach

Instead of trying to read the bundled output, debug the **source files**:

```
Your code:        src/
                  ├── lambda-http.ts
                  ├── lambda-worker.ts
                  ├── server-aws.ts
                  ├── shared/
                  └── functions/

Bundled output:   dist-lambda/
                  ├── http/index.js      (don't read this!)
                  └── worker/index.js    (don't read this!)
```

**If you find a bug:** 
1. Trace it using CloudWatch Logs from the Lambda function
2. Find the relevant source file in `src/`
3. Add logging or fix the logic there
4. Rebuild: `npm run build:lambda`
5. Deploy via GitHub Actions or manual ZIP upload

### Source Maps

Source maps are now generated during build (`--sourcemap=both`). This allows:
- IDE debuggers to show source TypeScript code
- Stack traces to reference original line numbers
- Better debugging experience despite minification

Files: `dist-lambda/{http,worker}/index.js.map`

## Production

These bundled files are uploaded to AWS Lambda via GitHub Actions:
- Trigger: Push to `backend-nodejs/**` on main branch
- Workflow: `.github/workflows/deploy-node-aws.yml`
- Process:
  1. Checkout code
  2. Install dependencies
  3. `npm run build:lambda` (generate bundles)
  4. Package each bundle as ZIP
  5. Upload to Lambda via AWS CLI
  6. Update Lambda configuration (environment variables)
