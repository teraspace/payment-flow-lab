# API application

Planned stack: NestJS + TypeScript + PostgreSQL. Use one modular API service with explicit domain/application boundaries. Controllers validate and translate HTTP requests; business rules and state transitions live in application/domain code. Provider requests stay outside database transactions.
