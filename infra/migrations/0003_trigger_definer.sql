-- 0003: trigger spójności rozmowa↔agent działa z uprawnieniami właściciela schematu,
-- aby jego wynik nie zależał od RLS wywołującego (wcześniej rola nova_app nie widziała cudzego agenta
-- i dostawała mylący komunikat). Odmowa pozostaje odmową; komunikat jest teraz precyzyjny.
ALTER FUNCTION conversations_agent_check() SECURITY DEFINER SET search_path = public;
