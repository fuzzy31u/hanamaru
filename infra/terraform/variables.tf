variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type    = string
  default = "asia-northeast1"
}

variable "service_name" {
  type    = string
  default = "hanamaru"
}

variable "image" {
  type        = string
  description = "Container image URL"
}

variable "enable_mongo_mcp" {
  type        = string
  description = "MongoDB MCP feature flag. 'true' で有効化。デフォルトは無効。"
  default     = "false"
}

variable "mongo_db_name" {
  type        = string
  description = "MongoDB MCP が使用する DB 名。"
  default     = "hanamaru"
}
