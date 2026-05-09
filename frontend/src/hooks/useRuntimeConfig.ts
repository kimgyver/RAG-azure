import { useCallback, useEffect, useState } from "react";
import type { RuntimeConfigSnapshot } from "../types/app";
import { resolveFetchErrorMessage } from "../utils/app";

type RuntimeState = {
  runtimeConfig: RuntimeConfigSnapshot | null;
  status: "loading" | "ok" | "error";
  errorMessage: string;
};

/**
 * Loads and manages backend runtime configuration (flags/deployment).
 */
export function useRuntimeConfig(
  apiBaseUrl: string,
  apiKey: string,
  backendTarget: string
) {
  const [runtimeState, setRuntimeState] = useState<RuntimeState>({
    runtimeConfig: null,
    status: "loading",
    errorMessage: ""
  });

  const load = useCallback(async () => {
    setRuntimeState({
      runtimeConfig: null,
      status: "loading",
      errorMessage: ""
    });

    try {
      const response = await fetch(`${apiBaseUrl}/flags/deployment`, {
        headers: {
          ...(apiKey ? { "x-functions-key": apiKey } : {})
        }
      });

      if (!response.ok) {
        throw new Error(String(response.status));
      }

      const payload = (await response.json()) as RuntimeConfigSnapshot;
      setRuntimeState({
        runtimeConfig: payload,
        status: "ok",
        errorMessage: ""
      });
    } catch (error) {
      const message = resolveFetchErrorMessage(
        error,
        backendTarget as any,
        apiBaseUrl,
        "Could not load backend flags."
      );
      setRuntimeState({
        runtimeConfig: null,
        status: "error",
        errorMessage: message
      });
    }
  }, [apiBaseUrl, apiKey, backendTarget]);

  useEffect(() => {
    void load();
  }, [load]);

  return runtimeState;
}
