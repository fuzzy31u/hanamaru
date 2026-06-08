terraform {
  required_version = ">= 1.7"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.36"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  required_apis = [
    "run.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "cloudbuild.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.required_apis)
  service            = each.value
  disable_on_destroy = false
}

resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.apis]
}

resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = var.service_name
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "runtime" {
  account_id   = "${var.service_name}-runtime"
  display_name = "Hanamaru Cloud Run runtime"
}

locals {
  runtime_roles = [
    "roles/aiplatform.user",
    "roles/secretmanager.secretAccessor",
    "roles/datastore.user",
    "roles/logging.logWriter",
  ]
}

resource "google_project_iam_member" "runtime_bindings" {
  for_each = toset(local.runtime_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret" "secrets" {
  for_each = toset([
    "slack-signing-secret",
    "slack-bot-token",
    "google-oauth-client-id",
    "google-oauth-client-secret",
    "google-calendar-refresh-token",
  ])
  secret_id = each.value
  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service" "hanamaru" {
  name     = var.service_name
  location = var.region

  template {
    service_account = google_service_account.runtime.email
    containers {
      image = var.image
      ports {
        container_port = 8080
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "GEMINI_LOCATION"
        value = var.region
      }
      env {
        name  = "GEMINI_MODEL"
        value = "gemini-2.5-flash"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.hanamaru.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
