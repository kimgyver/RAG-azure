locals {
  chat_alerts_enabled = var.enable_chat_alerts && length(var.chat_alert_email_receivers) > 0
}

resource "azurerm_monitor_action_group" "chat_ops" {
  count               = local.chat_alerts_enabled ? 1 : 0
  name                = "${local.slug}-${random_id.suffix.hex}-chat-ag"
  short_name          = "chatops"
  resource_group_name = azurerm_resource_group.main.name

  dynamic "email_receiver" {
    for_each = toset(var.chat_alert_email_receivers)
    content {
      name          = replace(replace(email_receiver.value, "@", "-"), ".", "-")
      email_address = email_receiver.value
    }
  }

  tags = local.common_tags
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "chat_failures" {
  count               = local.chat_alerts_enabled ? 1 : 0
  name                = "${local.slug}-${random_id.suffix.hex}-chat-fail"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_application_insights.main.id]
  description         = "Alert when /api/chat has repeated failed requests."
  severity            = 2
  enabled             = true
  evaluation_frequency = "PT5M"
  window_duration      = "PT10M"
  auto_mitigation_enabled = true

  criteria {
    query = <<-KQL
      requests
      | where timestamp > ago(10m)
      | where tostring(url) has "/api/chat"
      | where success == false
      | summarize AggregatedValue = count()
    KQL
    time_aggregation_method = "Total"
    operator                = "GreaterThan"
    threshold               = var.chat_failure_count_threshold
  }

  action {
    action_groups = [azurerm_monitor_action_group.chat_ops[0].id]
  }

  tags = local.common_tags
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "chat_latency" {
  count               = local.chat_alerts_enabled ? 1 : 0
  name                = "${local.slug}-${random_id.suffix.hex}-chat-lat"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_application_insights.main.id]
  description         = "Alert when p95 /api/chat latency exceeds threshold."
  severity            = 2
  enabled             = true
  evaluation_frequency = "PT5M"
  window_duration      = "PT10M"
  auto_mitigation_enabled = true

  criteria {
    query = <<-KQL
      requests
      | where timestamp > ago(10m)
      | where tostring(url) has "/api/chat"
      | summarize AggregatedValue = percentile(duration, 95) / 1ms
    KQL
    time_aggregation_method = "Average"
    operator                = "GreaterThan"
    threshold               = var.chat_latency_p95_threshold_ms
  }

  action {
    action_groups = [azurerm_monitor_action_group.chat_ops[0].id]
  }

  tags = local.common_tags
}
