# MyRiad Reception

MyRiad is a browser-based reception desk for a small Moroccan guesthouse. The demo uses Riad Safir Marrakech as its case study and runs with Node.js, PostgreSQL, and a set of fictional bookings.

## What you can do

- Find physical rooms that are available for every night of a requested stay.
- Register a lead guest, book several rooms together, and check guests in and out.
- Record card, cash, and bank-transfer receipts and see the remaining balance.
- Review expected arrivals and add room rates with effective dates.

## Run locally with Docker

Start Docker Desktop or Docker Engine. Clone the repository and run:

```sh
git clone https://github.com/soulaymanealahiane/myriad-reception.git
cd myriad-reception
docker compose up --build -d
```

Open [MyRiad Reception](http://localhost:3000) once both services are running. On the first start, PostgreSQL loads 24 fictional guests, 24 reservations, seven rooms, and a history of room rates and payments. The demo runs on your machine with its own database.

Use `docker compose ps` to check the services and `docker compose down` to stop them. The database volume retains changes between runs. To query the database from a terminal, run `docker compose exec db psql -U myriad -d myriad`.

If Compose reports that a container name is already in use, run `docker compose ps` from the project folder. If both MyRiad services are running, open the app at the address above. If you are running a separate clone at the same time, give it a different port with `MYRIAD_PORT`.

## Run locally with Node.js and PostgreSQL

1. On PostgreSQL 14 or later, create a new database called `myriad`. As its owner, run [`myriad.sql`](myriad.sql) in the pgAdmin Query Tool or with `psql -X -v ON_ERROR_STOP=1 -d myriad -f myriad.sql`. You can now try queries such as `SELECT * FROM payment;` directly in PostgreSQL.
2. Install Node.js 20 or later. From this folder, run `npm ci` (`npm.cmd ci` if Windows PowerShell blocks npm.ps1).
3. Set your connection options for the current shell and run `npm start` (`npm.cmd start` on Windows if needed).

   PowerShell example:

   ```powershell
   $env:PGHOST = '127.0.0.1'
   $env:PGPORT = '5432'
   $env:PGDATABASE = 'myriad'
   $env:PGUSER = 'postgres'
   $myriadPassword = Read-Host 'PostgreSQL password' -AsSecureString
   $env:PGPASSWORD = [System.Net.NetworkCredential]::new('', $myriadPassword).Password
   npm.cmd start
   ```

   On macOS/Linux the Node server also accepts `DATABASE_URL` as a PostgreSQL connection URI, or the same `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD` variables exported in your shell. Use the role that installed the schema for this local demonstration.

4. Open [MyRiad Reception](http://localhost:3000). Set `PORT` before startup to choose a different local port. With Compose, set `MYRIAD_PORT` instead.

The installer creates the `myriad` and `myriad_internal` schemas in one transaction. Sample dates are relative to installation day in Marrakech. Guest emails use reserved `.test` domains, and phone and identity references are masked.

### Update an older database

To enable short table names in an older installation, run [`enable_atlas_queries.sql`](enable_atlas_queries.sql) once as its database owner. The script keeps existing records and makes queries such as `SELECT * FROM payment;` work in new connections.

For a fresh sample dataset, install into a separate database such as `myriad_demo` and point `PGDATABASE` or `DATABASE_URL` at it. With Compose, use a separate project with its own volume.

## Try the reception workflow

1. **Overview.** On installation day, the dashboard shows two expected arrivals and four physical rooms free for tonight.
2. **Availability.** Search from the install date to two days later with all types selected. Rooms **102, 202, and 204** are available for every night. Room 102 can turn over on the previous guest's check-out day. Try ending one day sooner to see how the whole-stay result changes.
3. **Balances.** Open reservation **#1**, Amine Bennani. Two nights in two rooms cost **2,620 MAD**. Two payments total **900 MAD**, leaving **1,720 MAD**. Try **Check in** before recording the outstanding amount to see the database reject the transition. Record 1,720 MAD and check in to see the arrival disappear from the expected list.
4. **New reservation.** Select an available room, choose or register a lead guest, add the other rooms and guest counts, and save as pending. Record a card, cash, or transfer payment and confirm once at least 30% is collected. For cash in EUR, enter both the EUR amount received and its booked MAD equivalent. Check in after the full booking charge has been paid, then check out. Pending and confirmed reservations can also be cancelled.
5. **Rooms & rates.** Open rate history for any room type. Add a new physical room or rate, or create a new type together with its first room and first rate. Each booking keeps the rate effective when it was made.

## SQL and design

- [`myriad.sql`](myriad.sql) creates the tables, implements booking rules, loads sample records, and returns row counts. Try these queries in pgAdmin or `psql`:

  ```sql
  SELECT * FROM payment;
  SELECT * FROM rooms_available(business_today(), business_today() + 2);
  SELECT * FROM expected_arrivals();
  SELECT * FROM reservation_financials WHERE res_id = 1;
  ```

- Primary, foreign and unique keys and row checks cover local constraints. Transaction-end triggers enforce required children, occupancy and the total/disjoint payment hierarchy. On a status change, SQL checks the deposit, room overlaps and settlement. The singleton row in `myriad_internal.write_gate` serializes writes, including direct SQL writes, while availability and reports can use ordinary reads.
- Confirmed and checked-in bookings block rooms. Availability includes check-in and excludes check-out, allowing a new guest to arrive the day another leaves. A stay progresses from pending to confirmed, checked in, and checked out. Pending bookings can be changed through SQL, and reception can cancel pending and confirmed bookings.
- The app records receipts. Card receipts store the brand, last four digits, and authorization code. The demo uses fictional records and runs locally without a sign-in.
- The [schema report](Schema_Report.pdf) shows the functional dependencies for all ten tables. [`server.js`](server.js) connects the frontend in [`public/`](public/) to PostgreSQL through parameterized queries.
- To verify the SQL rules, install `myriad.sql` into a **separate disposable database**, point `MYRIAD_TEST_DATABASE_URL` at it, and run `npm test`. The suite includes a two-connection confirmation race and adds test bookings to that database.

## Contributing

Make changes on a branch and open a pull request against `main`. You can fork the repository for proposed changes. In the pull request, describe what changed and how you tested it.

## Credits

Built by Soulaymane Alahiane, Jihad El Hajji Anouar, and Hafsa El Mahfoudy as a database systems project.

Claude helped with the initial design draft. OpenAI Codex assisted with the PostgreSQL implementation, fictional sample data, reception interface, tests, and documentation.
