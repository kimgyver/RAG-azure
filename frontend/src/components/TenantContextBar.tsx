import type { BackendTarget } from "../types/app";
import {
  BACKEND_RESOURCE_LABELS,
  TENANT_OPTIONS_BY_BACKEND
} from "../utils/app";

type TenantContextBarProps = {
  tenantId: string;
  backendTarget: BackendTarget;
  backendApiBaseUrl: string;
  tenantError: string;
  onTenantIdChange: (value: string) => void;
  onBackendTargetChange: (value: BackendTarget) => void;
};

export function TenantContextBar({
  tenantId,
  backendTarget,
  backendApiBaseUrl,
  tenantError,
  onTenantIdChange,
  onBackendTargetChange
}: TenantContextBarProps) {
  const tenantOptions = TENANT_OPTIONS_BY_BACKEND[backendTarget];
  const resourceLabels = BACKEND_RESOURCE_LABELS[backendTarget];
  return (
    <div className="tenant-context-bar">
      <div className="tenant-context-row">
        <label className="tenant-context-label" htmlFor="backend-target">
          Backend
        </label>
        <select
          id="backend-target"
          className="backend-target-select"
          value={backendTarget}
          onChange={event => {
            const v = event.target.value;
            const value: import("../types/app").BackendTarget =
              v === "python"
                ? "python"
                : v === "aws"
                  ? "aws"
                  : v === "aws-python"
                    ? "aws-python"
                    : "node";
            onBackendTargetChange(value);
          }}
          aria-label="Select backend runtime"
        >
          <option value="node">Azure · Node (Functions)</option>
          <option value="python">Azure · Python (Container App)</option>
          <option value="aws">AWS · Node (Lambda)</option>
          <option value="aws-python">AWS · Python (EC2 + Docker)</option>
        </select>
        <label className="tenant-context-label" htmlFor="tenant-id">
          Tenant ID
        </label>
        <select
          id="tenant-id"
          className="tenant-context-input"
          value={tenantId}
          onChange={event => onTenantIdChange(event.target.value)}
          aria-describedby="tenant-context-desc"
        >
          {tenantOptions.map(t => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {tenantError ? (
        <p className="tenant-context-error" role="alert">
          {tenantError}
        </p>
      ) : null}
      <p id="tenant-context-desc" className="tenant-context-desc">
        Tenant access is restricted to the selected backend profile. Active
        resources: {resourceLabels.storageLabel}, {resourceLabels.metadataLabel}
        , {resourceLabels.searchLabel}. API: {backendApiBaseUrl}
      </p>
    </div>
  );
}
