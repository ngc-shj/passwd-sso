--
-- PostgreSQL database cluster dump
--

\restrict Re6JKneL8tWRQpWvfGYamm8dAMb8SNGavxe8qnUEMoXA3LnpCKNtcm4YNhIDYKe

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--
-- Roles
--

CREATE ROLE passwd_anchor_publisher;
ALTER ROLE passwd_anchor_publisher WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;