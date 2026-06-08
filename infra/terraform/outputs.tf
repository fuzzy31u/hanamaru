output "cloud_run_url" {
  value = google_cloud_run_v2_service.hanamaru.uri
}

output "artifact_registry_repo" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}"
}

output "runtime_sa_email" {
  value = google_service_account.runtime.email
}
