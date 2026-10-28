-- phone numbers: digits only, exactly 10; cleans saved phones first (drops symbols and a leading 1)

BEGIN;

UPDATE public.patient SET phone = regexp_replace(phone, '[^0-9]', '', 'g') WHERE phone ~ '[^0-9]';
UPDATE public.employee SET phone = regexp_replace(phone, '[^0-9]', '', 'g') WHERE phone ~ '[^0-9]';
UPDATE public.office SET phone = regexp_replace(phone, '[^0-9]', '', 'g') WHERE phone ~ '[^0-9]';
UPDATE public.emergency_contact SET phone_number = regexp_replace(phone_number, '[^0-9]', '', 'g') WHERE phone_number ~ '[^0-9]';

UPDATE public.patient SET phone = substring(phone FROM 2) WHERE phone ~ '^1[0-9]{10}$';
UPDATE public.employee SET phone = substring(phone FROM 2) WHERE phone ~ '^1[0-9]{10}$';
UPDATE public.office SET phone = substring(phone FROM 2) WHERE phone ~ '^1[0-9]{10}$';
UPDATE public.emergency_contact SET phone_number = substring(phone_number FROM 2) WHERE phone_number ~ '^1[0-9]{10}$';

ALTER TABLE public.patient ALTER COLUMN phone TYPE varchar(10);
ALTER TABLE public.employee ALTER COLUMN phone TYPE varchar(10);
ALTER TABLE public.office ALTER COLUMN phone TYPE varchar(10);
ALTER TABLE public.emergency_contact ALTER COLUMN phone_number TYPE varchar(10);

ALTER TABLE public.patient ADD CONSTRAINT chk_patient_phone CHECK (phone ~ '^[0-9]{10}$');
ALTER TABLE public.employee ADD CONSTRAINT chk_employee_phone CHECK (phone ~ '^[0-9]{10}$');
ALTER TABLE public.office ADD CONSTRAINT chk_office_phone CHECK (phone ~ '^[0-9]{10}$');
ALTER TABLE public.emergency_contact ADD CONSTRAINT chk_emergency_contact_phone CHECK (phone_number ~ '^[0-9]{10}$');

COMMIT;
