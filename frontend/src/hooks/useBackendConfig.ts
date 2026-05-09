import { useCallback, useMemo, useState } from "react";
import {
  type BackendTarget,
  TENANT_OPTIONS_BY_BACKEND,
  isAwsBackend
} from "../utils/app";

/**
 * Manages backend selection, tenant ID, and API configuration.
 * Responsible for: backend switching, tenant management, API URL/key resolution.
 */
export function useBackendConfig() {
  const defaultBackendTarget = useMemo(() => {
    const fromEnv = import.meta.env.VITE_DEFAULT_BACKEND?.trim().toLowerCase();
    if (fromEnv === "python") return "python";
    if (fromEnv === "aws") return "aws";
    if (fromEnv === "aws-python") return "aws-python";
    return "node";
  }, []);

  const [backendTarget, setBackendTarget] =
    useState<BackendTarget>(defaultBackendTarget);

  const [tenantIdByBackend, setTenantIdByBackend] = useState<
    Record<BackendTarget, string>
  >(() => {
    const record: Record<BackendTarget, string> = {
      node: TENANT_OPTIONS_BY_BACKEND.node[0],
      python: TENANT_OPTIONS_BY_BACKEND.python[0],
      aws: TENANT_OPTIONS_BY_BACKEND.aws[0],
      "aws-python": TENANT_OPTIONS_BY_BACKEND["aws-python"][0]
    };
    return record;
  });

  const [tenantErrorByBackend, setTenantErrorByBackend] = useState<
    Record<BackendTarget, string>
  >(() => ({
    node: "",
    python: "",
    aws: "",
    "aws-python": ""
  }));

  const apiUrls = useMemo(() => {
    const nodeBase = (
      import.meta.env.VITE_NODE_API_BASE_URL?.trim() ||
      import.meta.env.VITE_UPLOAD_API_BASE_URL?.trim() ||
      import.meta.env.VITE_API_BASE_URL?.trim() ||
      "/api"
    ).replace(/\/$/, "");

    const pythonBase = (
      import.meta.env.VITE_PYTHON_API_BASE_URL?.trim() || nodeBase
    ).replace(/\/$/, "");

    const defaultAwsNodeBase =
      "https://5xvuxdf5dl.execute-api.ap-southeast-2.amazonaws.com/api";
    const defaultAwsPythonBase =
      "https://wprvx1aiba.execute-api.ap-southeast-2.amazonaws.com/api";

    const configuredAwsBase = (
      import.meta.env.VITE_AWS_API_BASE_URL?.trim() || defaultAwsNodeBase
    ).replace(/\/$/, "");
    const configuredAwsPythonBase = (
      import.meta.env.VITE_AWS_PYTHON_API_BASE_URL?.trim() ||
      defaultAwsPythonBase
    ).replace(/\/$/, "");

    const awsBase =
      configuredAwsBase.includes("azurewebsites.net") ||
      configuredAwsBase.includes("azurecontainerapps.io")
        ? defaultAwsNodeBase
        : configuredAwsBase;
    const awsPythonBase =
      configuredAwsPythonBase.includes("azurewebsites.net") ||
      configuredAwsPythonBase.includes("azurecontainerapps.io") ||
      (window.location.protocol === "https:" &&
        configuredAwsPythonBase.startsWith("http://"))
        ? defaultAwsPythonBase
        : configuredAwsPythonBase;

    return { nodeBase, pythonBase, awsBase, awsPythonBase };
  }, []);

  const apiKeys = useMemo(
    () => ({
      nodeApiKey:
        import.meta.env.VITE_NODE_API_KEY?.trim() ||
        import.meta.env.VITE_UPLOAD_API_KEY?.trim() ||
        "",
      pythonApiKey: import.meta.env.VITE_PYTHON_API_KEY?.trim() || "",
      awsApiKey: import.meta.env.VITE_AWS_API_KEY?.trim() || ""
    }),
    []
  );

  const backendDefaultTenantId = TENANT_OPTIONS_BY_BACKEND[backendTarget][0];
  const tenantId = tenantIdByBackend[backendTarget] ?? backendDefaultTenantId;

  const apiBaseUrl = useMemo(() => {
    if (backendTarget === "python") return apiUrls.pythonBase;
    if (backendTarget === "aws") return apiUrls.awsBase;
    if (backendTarget === "aws-python") return apiUrls.awsPythonBase;
    return apiUrls.nodeBase;
  }, [backendTarget, apiUrls]);

  const apiKey =
    backendTarget === "python"
      ? apiKeys.pythonApiKey
      : backendTarget === "aws" || backendTarget === "aws-python"
        ? apiKeys.awsApiKey
        : apiKeys.nodeApiKey;

  const tenantError = tenantErrorByBackend[backendTarget];

  const onTenantIdChange = useCallback(
    (value: string) => {
      setTenantIdByBackend(prev => ({ ...prev, [backendTarget]: value }));
      if (tenantError) {
        setTenantErrorByBackend(prev => ({ ...prev, [backendTarget]: "" }));
      }
    },
    [backendTarget, tenantError]
  );

  const onBackendTargetChange = useCallback(
    (nextBackend: BackendTarget) => {
      if (nextBackend === backendTarget) {
        return;
      }

      const currentIsAws = isAwsBackend(backendTarget);
      const nextIsAws = isAwsBackend(nextBackend);

      if (currentIsAws === nextIsAws) {
        setTenantIdByBackend(prev => {
          const currentTenant =
            prev[backendTarget] ?? TENANT_OPTIONS_BY_BACKEND[backendTarget][0];
          const allowedForNext = TENANT_OPTIONS_BY_BACKEND[nextBackend];
          return {
            ...prev,
            [nextBackend]: allowedForNext.includes(currentTenant)
              ? currentTenant
              : allowedForNext[0]
          };
        });
      }

      setBackendTarget(nextBackend);
    },
    [backendTarget]
  );

  const clearTenantError = useCallback(() => {
    setTenantErrorByBackend(prev => ({ ...prev, [backendTarget]: "" }));
  }, [backendTarget]);

  const setTenantError = useCallback(
    (message: string) => {
      setTenantErrorByBackend(prev => ({
        ...prev,
        [backendTarget]: message
      }));
    },
    [backendTarget]
  );

  return {
    backendTarget,
    onBackendTargetChange,
    tenantId,
    onTenantIdChange,
    tenantError,
    clearTenantError,
    setTenantError,
    apiBaseUrl,
    apiKey
  };
}
