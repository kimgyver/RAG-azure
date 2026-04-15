/**
 * Optional comma-separated allowlist (e.g. `tenant-a,tenant-b`).
 * When unset or empty, any non-empty tenantId is accepted (local dev).
 */
export function isTenantAllowed(tenantId) {
    const raw = process.env.ALLOWED_TENANT_IDS?.trim();
    if (!raw) {
        return true;
    }
    const allowed = new Set(raw.split(",").map(entry => entry.trim()).filter(Boolean));
    return allowed.has(tenantId);
}
export function tenantNotAllowedMessage() {
    return "tenantId is not allowed for this deployment.";
}
