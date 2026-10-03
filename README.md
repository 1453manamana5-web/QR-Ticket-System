# QR Ticket System

Next-generation school festival ticket management system.

## Structure

- `management-app/` — management application
- `reception-app/` — reception application
- `shared/` — shared TypeScript types, constants, and validation

## Development principle

Reception must continue to work when the network is unavailable.

The reception app uses local data for reception decisions and synchronizes reception history when connectivity is available.
