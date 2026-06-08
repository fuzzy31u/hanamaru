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
