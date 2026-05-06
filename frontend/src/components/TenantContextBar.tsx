import type { BackendTarget } from "../types/app";

type TenantContextBarProps = {
  tenantId: string;
  effectiveTenantId: string;
  defaultTenantId: string;
  backendTarget: BackendTarget;
  backendApiBaseUrl: string;
  tenantError: string;
  onTenantIdChange: (value: string) => void;
  onBackendTargetChange: (value: BackendTarget) => void;
};

export function TenantContextBar({
  tenantId,
  effectiveTenantId,
  defaultTenantId,
  backendTarget,
  backendApiBaseUrl,
  tenantError,
  onTenantIdChange,
  onBackendTargetChange
}: TenantContextBarProps) {
  return (
    <div className="tenant-context-bar">
      <div className="tenant-context-row">
        <label className="tenant-context-label" htmlFor="tenant-id">
          Tenant ID
        </label>
        <input
          id="tenant-id"
          className="tenant-context-input"
          type="text"
          value={tenantId}
          onChange={event => onTenantIdChange(event.target.value)}
          placeholder={defaultTenantId}
          spellCheck={false}
          autoComplete="off"
          aria-describedby="tenant-context-desc"
        />
        <span className="tenant-context-sep" aria-hidden="true">
          →
        </span>
        <code className="tenant-context-id" title="Value sent to the API">
          {effectiveTenantId}
        </code>
        <label className="tenant-context-label" htmlFor="backend-target">
          Backend
        </label>
        <select
          id="backend-target"
          className="backend-target-select"
          value={backendTarget}
          onChange={event => {
            const value = event.target.value === "python" ? "python" : "node";
            onBackendTargetChange(value);
          }}
          aria-label="Select backend runtime"
        >
          <option value="node">Node (Functions)</option>
          <option value="python">Python (Web App / Container App)</option>
        </select>
      </div>
      {tenantError ? (
        <p className="tenant-context-error" role="alert">
          {tenantError}
        </p>
      ) : null}
      <p id="tenant-context-desc" className="tenant-context-desc">
        All operations (upload, search, chat) are isolated by tenant. Leave
        blank to use default. Active API: {backendApiBaseUrl}
      </p>
    </div>
  );
}
