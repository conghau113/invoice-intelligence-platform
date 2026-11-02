import os

# Settings require a service token; tests use this throw-away value (not a secret).
TEST_TOKEN = "test-service-token-0123456789"
os.environ.setdefault("AI_SERVICE_TOKEN", TEST_TOKEN)
