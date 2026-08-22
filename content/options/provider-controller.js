// @ts-check

import { clearButtonBusy, setButtonBusy } from "../../ui/button-state.js";

const STATUS_ICON_CLASSES = {
  secondary: "fas fa-info-circle",
  info: "fas fa-info-circle",
  success: "fas fa-check-circle",
  warning: "fas fa-exclamation-triangle",
  danger: "fas fa-times-circle",
};

export class ProviderController {
  constructor({ client, feedback, elements, onDataChanged }) {
    this.client = client;
    this.feedback = feedback;
    this.elements = elements;
    this.onDataChanged = onDataChanged;
  }

  bindEvents() {
    this.elements.providerIndexedDB.addEventListener("change", () => {
      void this.switchProvider("indexeddb");
    });

    this.elements.providerSupabase.addEventListener("change", () => {
      void this.switchProvider("supabase");
    });

    this.elements.enableAutoSync.addEventListener("change", (event) => {
      void this.toggleAutoSync(event.target.checked);
    });

    this.elements.saveSupabaseCredentialsButton.addEventListener(
      "click",
      () => {
        void this.saveSupabaseCredentials();
      },
    );
    this.elements.testSupabaseButton.addEventListener("click", () => {
      void this.testSupabaseConnection();
    });

    this.elements.copySqlButton.addEventListener("click", () => {
      void this.copySqlToClipboard();
    });
  }

  async updateProviderStatus() {
    try {
      const [providerResponse, autoSyncResult] = await Promise.all([
        this.client.sendMessage({ action: "database-provider-status" }),
        chrome.storage.sync.get(["auto_sync_enabled"]),
      ]);

      const providerType = providerResponse?.status?.type || "indexeddb";
      this.elements.providerIndexedDB.checked = providerType === "indexeddb";
      this.elements.providerSupabase.checked = providerType === "supabase";
      this.elements.enableAutoSync.checked =
        autoSyncResult.auto_sync_enabled || false;
      this.elements.supabaseConfig.classList.toggle(
        "d-none",
        providerType !== "supabase",
      );

      if (providerType === "supabase") {
        await this.loadSupabaseConfig();
      }
    } catch (error) {
      this.feedback.error(`Failed to load provider status: ${error.message}`);
    }
  }

  async switchProvider(provider) {
    try {
      if (provider === "indexeddb") {
        this.elements.supabaseConfig.classList.add("d-none");
        this.hideSetupInstructions();
        await this.commitProviderChange("indexeddb");
        return;
      }

      this.elements.supabaseConfig.classList.remove("d-none");
      await this.loadSupabaseConfig();

      const status = await this.client.sendMessage({
        action: "supabase-get-status",
      });
      if (!status?.success || !status?.status?.configured) {
        this.updateSupabaseStatus(
          "secondary",
          "Enter your credentials and click Save Credentials.",
        );
        this.showSetupInstructions();
        return;
      }

      if (!status.status.authenticated) {
        this.updateSupabaseStatus(
          "secondary",
          "The saved login is no longer valid. Enter your credentials and save again.",
        );
        return;
      }

      this.updateSupabaseStatus("info", "Testing saved credentials...");
      const testResponse = await this.client.sendMessage({
        action: "supabase-test",
      });
      if (!testResponse?.success) {
        throw new Error(testResponse?.error || "Saved credentials failed");
      }

      const tableExists = await this.checkTableExists();
      if (!tableExists) {
        this.updateSupabaseStatus(
          "warning",
          "Connection successful, but the table setup is required before Supabase can be enabled.",
        );
        this.showSetupInstructions();
        return;
      }

      await this.commitProviderChange("supabase");
      this.updateSupabaseStatus(
        "success",
        "Connected to Supabase. Table is ready.",
      );
      this.hideSetupInstructions();
    } catch (error) {
      this.feedback.error(`Provider switch failed: ${error.message}`);
      this.elements.providerIndexedDB.checked = provider !== "indexeddb";
      this.elements.providerSupabase.checked = provider !== "supabase";
    }
  }

  async commitProviderChange(provider) {
    const response = await this.client.sendMessage({
      action: "database-provider-switch",
      provider,
    });

    if (!response?.success) {
      throw new Error(response?.error || "Provider switch failed");
    }

    this.feedback.success(
      `Switched to ${provider === "indexeddb" ? "Local Storage" : "Supabase"}`,
    );
    await this.onDataChanged();
  }

  async toggleAutoSync(isEnabled) {
    try {
      await chrome.storage.sync.set({ auto_sync_enabled: isEnabled });
      const response = await this.client.sendMessage({
        action: isEnabled ? "sync-manager-start" : "sync-manager-stop",
      });

      if (!response?.success) {
        throw new Error(response?.error || "Auto sync update failed");
      }

      this.feedback.success(
        `Automatic synchronization ${isEnabled ? "enabled" : "disabled"}`,
      );
    } catch (error) {
      this.elements.enableAutoSync.checked = !isEnabled;
      this.feedback.error(`Automatic synchronization failed: ${error.message}`);
    }
  }

  getSupabaseCredentialInput() {
    const projectId = this.elements.supabaseProjectId.value.trim();
    const publishableKey = this.elements.supabaseApiKey.value.trim();
    if (!projectId || !publishableKey) {
      throw new Error("Enter both the Supabase project ID and publishable key");
    }
    const email = this.elements.supabaseEmail.value.trim();
    const password = this.elements.supabasePassword.value;
    if (!email || !password) {
      throw new Error("Email and password are required");
    }
    return {
      configuration: { projectId, publishableKey },
      email,
      password,
    };
  }

  async saveSupabaseCredentials() {
    const button = this.elements.saveSupabaseCredentialsButton;
    try {
      const credentials = this.getSupabaseCredentialInput();
      setButtonBusy(button, "Saving...");
      const response = await this.client.sendMessage({
        action: "supabase-save-credentials",
        ...credentials,
      });
      if (!response?.success) {
        throw new Error(response?.error || "Credentials could not be saved");
      }

      this.elements.supabaseApiKey.value = "";
      this.elements.supabasePassword.value = "";
      await this.loadSupabaseConfig();
      this.feedback.success("Supabase credentials saved securely");
      await this.switchProvider("supabase");
    } catch (error) {
      this.feedback.error(
        `Saving Supabase credentials failed: ${error.message}`,
      );
    } finally {
      clearButtonBusy(button);
    }
  }

  async testSupabaseConnection() {
    try {
      setButtonBusy(this.elements.testSupabaseButton, "Testing...");

      const response = await this.client.sendMessage({
        action: "supabase-test",
      });
      if (!response?.success) {
        throw new Error(response?.error || "Connection test failed");
      }

      const tableExists = await this.checkTableExists();
      if (tableExists) {
        this.updateSupabaseStatus(
          "success",
          "Connection successful. Table is ready.",
        );
        this.hideSetupInstructions();
      } else {
        this.updateSupabaseStatus(
          "warning",
          "Connection successful, but the table setup is still required.",
        );
        this.showSetupInstructions();
      }
    } catch (error) {
      this.updateSupabaseStatus(
        "danger",
        `Connection failed: ${error.message}`,
      );
      await this.loadSupabaseConfig();
    } finally {
      clearButtonBusy(this.elements.testSupabaseButton);
    }
  }

  async loadSupabaseConfig() {
    try {
      const response = await this.client.sendMessage({
        action: "supabase-get-credentials",
      });
      if (!response?.success || !response.credentials) {
        this.elements.currentConfig.classList.add("d-none");
        this.elements.testSupabaseButton.classList.add("d-none");
        this.elements.testSupabaseButton.disabled = true;
        return;
      }

      this.elements.currentProjectId.textContent =
        response.credentials.projectId || "-";
      this.elements.currentApiKey.textContent =
        response.credentials.publishableKey || "-";
      this.elements.currentAuthUser.textContent = response.credentials
        .authenticated
        ? response.credentials.userEmail || "Signed in"
        : "Not signed in";
      this.elements.currentConfig.classList.remove("d-none");
      this.elements.testSupabaseButton.classList.remove("d-none");
      this.elements.testSupabaseButton.disabled =
        !response.credentials.authenticated;
    } catch (_error) {
      this.elements.currentConfig.classList.add("d-none");
      this.elements.testSupabaseButton.classList.add("d-none");
      this.elements.testSupabaseButton.disabled = true;
    }
  }

  async copySqlToClipboard() {
    try {
      const sqlCode =
        document.getElementById("supabase-sql-code")?.textContent || "";
      await navigator.clipboard.writeText(sqlCode);
      this.feedback.success("SQL code copied to clipboard");
    } catch (_error) {
      this.feedback.error("Failed to copy SQL code");
    }
  }

  async checkTableExists() {
    const response = await this.client.sendMessage({
      action: "supabase-check-table",
    });
    return Boolean(response?.success && response.tableExists);
  }

  updateSupabaseStatus(level, text) {
    this.elements.supabaseStatus.className = `alert alert-${level} mt-3`;
    this.elements.supabaseStatusIcon.innerHTML = `<i class="${STATUS_ICON_CLASSES[level] || STATUS_ICON_CLASSES.info}"></i>`;
    this.elements.supabaseStatusText.textContent = text;
    this.elements.supabaseStatus.classList.remove("d-none");
  }

  showSetupInstructions() {
    this.elements.supabaseSetupInstructions.classList.remove("d-none");
  }

  hideSetupInstructions() {
    this.elements.supabaseSetupInstructions.classList.add("d-none");
  }
}
