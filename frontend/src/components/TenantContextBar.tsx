type TenantContextBarProps = {
  tenantId: string;
  effectiveTenantId: string;
  defaultTenantId: string;
  tenantError: string;
  onTenantIdChange: (value: string) => void;
};

export function TenantContextBar({
  tenantId,
  effectiveTenantId,
  defaultTenantId,
  tenantError,
  onTenantIdChange
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
      </div>
      {tenantError ? (
        <p className="tenant-context-error" role="alert">
          {tenantError}
        </p>
      ) : null}
      <p id="tenant-context-desc" className="tenant-context-desc">
        Upload, blob path, indexing, chat retrieval, catalog, and purge all use
        the <strong>same</strong> tenant. Leave blank for default{" "}
        <code className="inline-code">{defaultTenantId}</code> from{" "}
        <code className="inline-code">VITE_TENANT_ID</code>.
      </p>
    </div>
  );
}
